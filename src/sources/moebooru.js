/**
 * Moebooru 适配器 — yande.re / konachan 一类的图站共用同一套 API。
 *
 * 与 Pixiv 的关键差异（决定了上层要按 caps 分支）：
 *   - 一条 post = 一张图，没有多页插画 → pageCount 恒为 1
 *   - 没有标题字段 → 用首个 tag 兜底（文件名与详情页标题都用它）
 *   - 没有点赞/关注/相关推荐等账号态
 *   - id 是数字且与 Pixiv 撞号 → illustId 一律走 qualifyId 加来源前缀
 *
 * 文档：https://yande.re/help/api
 */
import { createTransport } from '../api/transport.js';
import { qualifyId, rawIdOf, sourceOfId } from '../pixiv-assistant/core/utils.js';
import { getSource } from './registry.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('moebooru');

/** yande / konachan 的 tags 语法用 `+` 连接多个 tag（AND 语义） */
function encodeTags(tags) {
  return encodeURIComponent(tags).replace(/%20/g, '+');
}

/** 各站的网页地址模板 */
const POST_URL = {
  yande: (id) => `https://yande.re/post/show/${id}`,
  konachan: (id) => `https://konachan.com/post/show/${id}`,
};

function classifyError(e, what) {
  const msg = e?.message || String(e);
  if (/Failed to fetch|NetworkError|ERR_NETWORK|ENOTFOUND|ECONNREFUSED|abort|timeout/i.test(msg)) {
    return `网络连接失败（${what}），请检查网络或代理设置`;
  }
  const code = typeof e?.status === 'number' ? e.status : Number(msg.match(/HTTP\s+(\d+)/)?.[1]);
  if (code === 403) return `${what}被拒绝访问（403）`;
  if (code === 404) return `${what}未找到，可能已被删除`;
  if (code === 429) return '请求过于频繁，请稍后再试';
  if (code >= 500) return `${what}服务暂时不可用，请稍后重试`;
  if (code) return `${what}请求失败（HTTP ${code}）`;
  return msg;
}

/**
 * 一条 Moebooru post → 应用统一条目。
 * 字段名刻意与 mapIllustItem 对齐，让 GridItem / 灯箱 / 详情堆叠零改动渲染。
 * @param {object} post
 * @param {string} sourceId
 */
function mapPost(post, sourceId) {
  const rawId = String(post?.id ?? '');
  if (!rawId) return null;
  const tags = String(post.tags || '').split(/\s+/).filter(Boolean);
  // 无标题字段：首个 tag 通常是角色/作品名，作标题比留空有用（文件名与详情页标题都用它）
  const title = tags[0] || '';
  const author = post.author || '';
  return {
    illustId: qualifyId(sourceId, rawId),
    source: sourceId,
    title,
    author,
    authorName: author,
    authorAccount: '',
    authorId: '',          // 无作者 id：关注按钮与作者页点击自然隐藏（均以 authorId 为守卫）
    authorAvatar: '',
    thumbnailUrl: post.preview_url || '',
    mediumUrl: post.sample_url || post.jpeg_url || post.file_url || '',
    originalUrl: post.file_url || post.jpeg_url || post.sample_url || '',
    tags,
    pixivUrl: '',          // 非 Pixiv 来源不伪造 pixiv 链接，外链一律走 webUrl
    webUrl: POST_URL[sourceId]?.(rawId) || '',
    pageCount: 1,
    type: 'image',         // booru 无动图，恒为静态图
    illustType: 0,
    width: post.width || 0,
    height: post.height || 0,
    rating: post.rating || '',
    score: post.score || 0,
    _pageIndex: 0,
  };
}

/** 统一条目 → 详情页需要的 illust 结构（与 pixiv fetchIllust 的返回形状对齐） */
function toIllust(item) {
  return {
    illustId: item.illustId,
    title: item.title,
    authorName: item.authorName,
    authorAccount: '',
    authorId: '',
    tags: item.tags,
    pageCount: 1,
    illustType: 0,
    width: item.width,
    height: item.height,
    webUrl: item.webUrl,
    images: [{
      index: 0,
      url: item.mediumUrl,
      previewUrl: item.mediumUrl,
      thumbnailUrl: item.thumbnailUrl,
      mediumUrl: item.mediumUrl,
      originalUrl: item.originalUrl,
      width: item.width,
      height: item.height,
    }],
  };
}

/**
 * 从用户输入里抽站点原始 id：纯数字、或 `yande.re/post/show/123` 这类链接。
 * @returns {string} 未命中返回 ''
 */
function extractPostId(query) {
  const url = query.match(/\/post\/show\/(\d+)/i)?.[1];
  if (url) return url;
  return /^\d+$/.test(query) ? query : '';
}

/**
 * 创建一个 Moebooru 系来源。
 * @param {{id:string}} def — registry 里的来源定义
 */
export function createMoebooruSource(def) {
  const sourceId = def.id;
  const transport = createTransport({
    apiPrefix: def.net.apiPrefix,
    origin: def.net.apiOrigin,
    logName: `booru:${sourceId}`,
  });

  /** 取一页 post */
  async function listPosts(tags, { page = 1, limit = 20 } = {}) {
    const qs = `?tags=${encodeTags(tags)}&limit=${limit}&page=${page}`;
    const data = await transport(`/post.json${qs}`);
    return Array.isArray(data) ? data : [];
  }

  return {
    id: sourceId,
    def,

    /**
     * 标签 / ID 搜索。
     * 纯数字与 post 链接按 id 直查（与 pixiv 的 searchPixiv 习惯一致），其余按 tag 原样送。
     * @returns {Promise<{images: object[], query: string, total?: number, error?: string}>}
     */
    async search(query, { page = 1, limit = 20, safeOnly = false } = {}) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return { images: [], query: '' };
      const postId = extractPostId(trimmed);
      try {
        if (postId) {
          const posts = await listPosts(`id:${postId}`, { page: 1, limit: 1 });
          return { images: posts.map(p => mapPost(p, sourceId)).filter(Boolean), query: trimmed, total: 1 };
        }
        let tags = trimmed;
        if (safeOnly) tags += ' rating:safe';
        const posts = await listPosts(tags, { page, limit });
        return { images: posts.map(p => mapPost(p, sourceId)).filter(Boolean), query: trimmed };
      } catch (e) {
        log.error('[search] 失败:', e?.message || e);
        return { images: [], query: trimmed, error: classifyError(e, '搜索') };
      }
    },

    /**
     * 推荐流 — 按评分排序的「精选」。
     * Moebooru 没有 Pixiv 那种个性化推荐，order:score 是它唯一可用的排序语义
     * （order:random 与 post/random.json 实测均返回空）。
     * @returns {Promise<{illusts: object[], message?: string}>}
     */
    async feed({ page = 1, limit = 20 } = {}) {
      try {
        const posts = await listPosts('order:score', { page, limit });
        return { illusts: posts.map(p => mapPost(p, sourceId)).filter(Boolean) };
      } catch (e) {
        log.error('[feed] 失败:', e?.message || e);
        return { illusts: [], message: classifyError(e, '推荐') };
      }
    },

    /**
     * 榜单 — popular_recent 的日 / 周 / 月三档。
     * @param {{period?: '1d'|'1w'|'1m', limit?: number}} opts
     * @returns {Promise<{illusts: object[], error?: string}>}
     */
    async popular({ period = '1d', limit = 20 } = {}) {
      try {
        const data = await transport(`/post/popular_recent.json?period=${period}`);
        const posts = (Array.isArray(data) ? data : []).slice(0, limit);
        return { illusts: posts.map(p => mapPost(p, sourceId)).filter(Boolean) };
      } catch (e) {
        log.error('[popular] 失败:', e?.message || e);
        return { illusts: [], error: classifyError(e, '排行榜') };
      }
    },

    /**
     * 按 ID 取单条详情（详情页 / 保存时补全 URL）。
     * 名字与 pixivApi.fetchIllust 对齐，详情页据此按来源分发。
     * 接受带来源前缀的 illustId，也接受裸站点 id。
     * @param {string} illustId
     * @returns {Promise<{illust: object|null, error?: string}>}
     */
    async fetchIllust(illustId) {
      const id = sourceOfId(illustId) === sourceId ? rawIdOf(illustId) : String(illustId);
      if (!id) return { illust: null, error: '作品 ID 为空' };
      try {
        const posts = await listPosts(`id:${id}`, { page: 1, limit: 1 });
        const item = posts.length ? mapPost(posts[0], sourceId) : null;
        if (!item) return { illust: null, error: '作品未找到，可能已被删除' };
        return { illust: toIllust(item) };
      } catch (e) {
        log.error('[fetchIllust] 失败:', e?.message || e);
        return { illust: null, error: classifyError(e, '作品详情') };
      }
    },
  };
}

/** 单例缓存：每个来源一个适配器实例 */
const instances = new Map();

/**
 * 取某来源的适配器（懒建）。
 * @param {string} sourceId
 */
export function getMoebooruSource(sourceId) {
  const def = getSource(sourceId);
  if (def.kind !== 'moebooru') return null;
  if (!instances.has(sourceId)) instances.set(sourceId, createMoebooruSource(def));
  return instances.get(sourceId);
}

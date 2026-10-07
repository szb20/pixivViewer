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
import { createLogger } from '../utils/logger.js';
import { classifyError, extractPostId, toIllust } from './shared.js';

const log = createLogger('moebooru');

/**
 * 推荐流的分数下限 —— 配合默认序（新→旧）取「近期高分」。
 *
 * order:score 是**纯分数序**，榜首常年是十几年前的图（实测 yande 首条 id 315186，
 * 而站点最新 id 是 127 万），拿它当推荐流用户一眼就看出「全是老图」。
 * 默认序 + score:>=N 才能拿到「刚上传不久、已经有人投票」的那批。
 *
 * 实测（2026-10）N=20：首条只比站点最新 id 落后个位数到二十几条，
 * 且翻到第 500 页仍有数据（yande id 1267655 / konachan id 407026），够刷。
 */
const FEED_MIN_SCORE = 20;

/** yande / konachan 的 tags 语法用 `+` 连接多个 tag（AND 语义） */
function encodeTags(tags) {
  return encodeURIComponent(tags).replace(/%20/g, '+');
}

/** 各站的网页地址模板 */
const POST_URL = {
  yande: (id) => `https://yande.re/post/show/${id}`,
  konachan: (id) => `https://konachan.com/post/show/${id}`,
  'konachan-net': (id) => `https://konachan.net/post/show/${id}`,
  sakugabooru: (id) => `https://www.sakugabooru.com/post/show/${id}`,
};

/** 静态图片扩展名 —— sakugabooru 一类视频站混着 mp4/webm 条目，图片流里只保留静态图 */
const STATIC_EXTS = /\.(jpe?g|png|gif|webp|avif)$/i;

/**
 * 一条 Moebooru post → 应用统一条目。
 * 字段名刻意与 mapIllustItem 对齐，让 GridItem / 灯箱 / 详情堆叠零改动渲染。
 * @param {object} post
 * @param {string} sourceId
 */
function mapPost(post, sourceId) {
  const rawId = String(post?.id ?? '');
  if (!rawId) return null;
  const fileUrl = post.file_url || '';
  // sakugabooru 是作画截图站，一半条目是 mp4/webm（本应用按静态图渲染，点开必裂）——直接丢弃
  if (fileUrl && !STATIC_EXTS.test(fileUrl.split('?')[0])) return null;
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
    userAgent: def.net.userAgent,
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
      const postId = extractPostId(trimmed, /\/post\/show\/(\d+)/i);
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
     * 推荐流 — 近期高分：默认序（新→旧）+ score:>=N，**不用 order:score**（见 FEED_MIN_SCORE）。
     * 阈值可按源覆盖（def.feedMinScore）：sakugabooru 的投票文化与壁纸站不同，20 会筛成空流。
     * @returns {Promise<{illusts: object[], message?: string}>}
     */
    async feed({ page = 1, limit = 20, safeOnly = false } = {}) {
      try {
        let tags = `score:>=${def.feedMinScore ?? FEED_MIN_SCORE}`;
        if (safeOnly) tags += ' rating:safe';
        const posts = await listPosts(tags, { page, limit });
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

/**
 * Danbooru 适配器 — danbooru.donmai.us 及其同构镜像（safebooru.donmai.us / hijiribe）。
 *
 * 与 Moebooru 的关键差异：
 *   - 字段名不同：file_url / large_file_url / preview_file_url / tag_string
 *   - 分级是 g/s/q/e（general/sensitive/questionable/explicit），不是 s/q/e
 *   - 排序走 `order:` 元标签；但 order:score / order:favcount / order:random 对匿名用户
 *     会 500（ActiveRecord::QueryCanceled，库太大），只有 order:rank / order:created 可用
 *   - 匿名最多 2 个 tag（超出返回 422 PostQuery::TagLimitError）
 *   - 站点在 Cloudflare 后面：浏览器 UA 会被 JS 挑战挡死，必须走 net.userAgent
 *
 * 文档：https://danbooru.donmai.us/wiki_pages/help:api
 */
import { createTransport } from '../api/transport.js';
import { qualifyId, rawIdOf, sourceOfId } from '../pixiv-assistant/core/utils.js';
import { createLogger } from '../utils/logger.js';
import { classifyError, extractPostId, toIllust } from './shared.js';

const log = createLogger('danbooru');

/** 匿名可用的 tag 数上限（超出上游直接 422） */
const ANON_TAG_LIMIT = 2;

/**
 * 从 media_asset.variants 里挑指定档位的 URL。
 * 新版 API 才带 variants，老响应没有 → 调用方按 file_url 系列字段兜底。
 */
function variantUrl(post, type) {
  const variants = post?.media_asset?.variants;
  if (!Array.isArray(variants)) return '';
  return variants.find(v => v?.type === type)?.url || '';
}

/**
 * 一条 Danbooru post → 应用统一条目。
 * @param {object} post
 * @param {string} sourceId
 * @returns {object|null} 无可用图片地址时返回 null（已删除 / 仅会员可见）
 */
function mapPost(post, sourceId) {
  const rawId = String(post?.id ?? '');
  if (!rawId) return null;
  const original = post.file_url || post.large_file_url || '';
  if (!original) return null; // banned / 仅 Gold 可见：整条丢弃，免得详情页点开是空白
  const allTags = String(post.tag_string || '').split(/\s+/).filter(Boolean);
  // 按「角色 → 作品 → 任意」挑标题：tag_string 是字母序的，取首个只会得到 "1girl"
  const pickFirst = (str) => String(str || '').split(/\s+/).filter(Boolean)[0] || '';
  const title = pickFirst(post.tag_string_character) || pickFirst(post.tag_string_copyright) || allTags[0] || '';
  const author = pickFirst(post.tag_string_artist);
  return {
    illustId: qualifyId(sourceId, rawId),
    source: sourceId,
    title,
    author,
    authorName: author,
    authorAccount: '',
    authorId: '',          // 无作者 id：关注按钮与作者页点击自然隐藏（均以 authorId 为守卫）
    authorAvatar: '',
    // 360 档比 180 档更适合网格（网格单元约 180-220px，180 会糊）
    thumbnailUrl: variantUrl(post, '360x360') || post.preview_file_url || original,
    mediumUrl: post.large_file_url || original,
    originalUrl: original,
    tags: allTags,
    pixivUrl: '',          // 非 Pixiv 来源不伪造 pixiv 链接，外链一律走 webUrl
    webUrl: `https://danbooru.donmai.us/posts/${rawId}`,
    pageCount: 1,
    type: 'image',         // Danbooru 的 ugoira 是独立字段（file_ext=zip），一律按静态图处理
    illustType: 0,
    width: post.image_width || 0,
    height: post.image_height || 0,
    rating: post.rating || '',
    score: post.score || 0,
    _pageIndex: 0,
  };
}

/** 默认排序：最新在前（不传任何 order: 元标签） */
function searchTags(query, safeOnly) {
  let tags = String(query || '').trim();
  const parts = tags.split(/\s+/).filter(Boolean);
  if (parts.length > ANON_TAG_LIMIT) {
    // 匿名上限：超出会被上游 422，这里截断而不是报错（用户少一个限定词总比搜不出东西好）
    log.debug(`[search] 匿名最多 ${ANON_TAG_LIMIT} 个 tag，已截断:`, tags);
    tags = parts.slice(0, ANON_TAG_LIMIT).join(' ');
  }
  if (safeOnly) tags = `${tags} rating:g`.trim();
  return tags;
}

/**
 * 创建一个 Danbooru 系来源。
 * @param {{id:string, net:object}} def — registry 里的来源定义
 */
export function createDanbooruSource(def) {
  const sourceId = def.id;
  const transport = createTransport({
    apiPrefix: def.net.apiPrefix,
    origin: def.net.apiOrigin,
    logName: `booru:${sourceId}`,
    userAgent: def.net.userAgent,
  });

  /** 取一页 post */
  async function listPosts(tags, { page = 1, limit = 20 } = {}) {
    const qs = `?tags=${encodeURIComponent(tags)}&limit=${limit}&page=${page}`;
    const data = await transport(`/posts.json${qs}`);
    return Array.isArray(data) ? data : [];
  }

  return {
    id: sourceId,
    def,
    /** 诚实反映上游真实可用的排序（order:score 等对匿名用户 500，不能用） */
    rankingModes: [
      { key: 'day', label: '日榜' },
      { key: 'week', label: '周榜' },
      { key: 'month', label: '月榜' },
    ],

    /**
     * 标签 / ID 搜索。
     * 纯数字与 /posts/123 链接按 id 直查（与 pixiv 的搜索习惯一致），其余按 tag 原样送。
     * @returns {Promise<{images: object[], query: string, total?: number, error?: string}>}
     */
    async search(query, { page = 1, limit = 20, safeOnly = false } = {}) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return { images: [], query: '' };
      const postId = extractPostId(trimmed, /\/posts\/(\d+)/i);
      try {
        if (postId) {
          const posts = await listPosts(`id:${postId}`, { page: 1, limit: 1 });
          return { images: posts.map(p => mapPost(p, sourceId)).filter(Boolean), query: trimmed, total: 1 };
        }
        const posts = await listPosts(searchTags(trimmed, safeOnly), { page, limit });
        return { images: posts.map(p => mapPost(p, sourceId)).filter(Boolean), query: trimmed };
      } catch (e) {
        log.error('[search] 失败:', e?.message || e);
        return { images: [], query: trimmed, error: classifyError(e, '搜索') };
      }
    },

    /**
     * 推荐流 —— order:rank（站点热度排序，约等于「今天的热门」）。
     * @returns {Promise<{illusts: object[], message?: string}>}
     */
    async feed({ page = 1, limit = 20, safeOnly = false } = {}) {
      try {
        let tags = 'order:rank';
        if (safeOnly) tags += ' rating:g';
        const posts = await listPosts(tags, { page, limit });
        return { illusts: posts.map(p => mapPost(p, sourceId)).filter(Boolean) };
      } catch (e) {
        log.error('[feed] 失败:', e?.message || e);
        return { illusts: [], message: classifyError(e, '推荐') };
      }
    },

    /**
     * 榜单 —— 官方 /explore/posts/popular 的日 / 周 / 月三档（实测三档均可用）。
     * 注意两处：
     *   1. 端点挂在 /explore 下，不是 /posts/popular.json（后者 404）
     *   2. **不要传 date**：不传时上游按站点时区取「今天」，传了就要自己算日期，
     *      而设备本地日期可能比站点时区早一天 → 返回空数组（实测 date=明天 → []），
     *      于是每天有一段固定时间榜单是空的。
     * @param {{period?: 'day'|'week'|'month', limit?: number}} opts
     * @returns {Promise<{illusts: object[], error?: string}>}
     */
    async popular({ period = 'day', limit = 20 } = {}) {
      const scale = ['day', 'week', 'month'].includes(period) ? period : 'day';
      try {
        const data = await transport(`/explore/posts/popular.json?scale=${scale}`);
        const posts = (Array.isArray(data) ? data : []).slice(0, limit);
        return { illusts: posts.map(p => mapPost(p, sourceId)).filter(Boolean) };
      } catch (e) {
        log.error('[popular] 失败:', e?.message || e);
        return { illusts: [], error: classifyError(e, '排行榜') };
      }
    },

    /**
     * 按 ID 取单条详情（详情页 / 保存时补全 URL）。
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

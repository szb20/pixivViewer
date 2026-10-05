/**
 * Wallhaven 适配器 — wallhaven.cc/api/v1。
 *
 * 与 booru 系的差异：
 *   - 有官方 REST API（唯一一个不需要绕的），响应统一包一层 { data, meta }
 *   - **没有 tag 体系**：搜索是关键词 q，条目也不带标签/作者/标题 —— 标题与作者只能留空
 *   - 分级是 purity（sfw / sketchy / nsfw），不是 rating
 *   - 榜单没有独立端点，是 search 的一种排序（sorting=toplist + topRange），
 *     档位比 booru 系丰富（1d/3d/1w/1M/3M/6M/1y）
 *
 * 关于 purity：实测匿名能拿到 sfw + sketchy，**nsfw 需要 API key**（无 key 时被静默滤掉）。
 * 所以「全部」档只能给到 110（sfw+sketchy），这与 yande / konachan 的「全部」不等价。
 * 将来若加凭据存储，把 ALL_PURITY 改成 111 即可。
 *
 * categories 固定 010（只出 anime 类）：这是个动漫看图应用，
 * general（摄影/抽象）与 people（人像）两类放进来只会污染结果。
 *
 * 文档：https://wallhaven.cc/help/api
 */
import { createTransport } from '../api/transport.js';
import { qualifyId, rawIdOf, sourceOfId } from '../pixiv-assistant/core/utils.js';
import { createLogger } from '../utils/logger.js';
import { classifyError, parseResolution, toIllust } from './shared.js';

const log = createLogger('wallhaven');

/** 只出 anime 类（general / anime / people 三位掩码） */
const CATEGORIES = '010';
/** 「仅安全」档：只出 sfw */
const SAFE_PURITY = '100';
/** 「全部」档：sfw + sketchy（nsfw 需 API key，匿名拿不到） */
const ALL_PURITY = '110';

/** 榜单档位 —— 用 Wallhaven 自己的取值范围（1d ~ 1y），只做中文短标签 */
const TOP_RANGE_LABELS = {
  '1d': '日榜', '3d': '3日', '1w': '周榜', '1M': '月榜', '3M': '3月', '6M': '半年', '1y': '年榜',
};
const TOP_RANGES = Object.keys(TOP_RANGE_LABELS);

/**
 * 从用户输入里抽 Wallhaven id。
 * 只认链接形态（`wallhaven.cc/w/216o5y` / `whvn.cc/216o5y`）——
 * id 是 6 位字母数字，与普通搜索词长得一样，裸词一律当搜索词处理。
 * @returns {string} 未命中返回 ''
 */
function extractWallhavenId(query) {
  return String(query || '').match(/(?:wallhaven\.cc\/w\/|whvn\.cc\/)([a-z0-9]+)/i)?.[1] || '';
}

/**
 * 一条 Wallhaven 条目 → 应用统一条目。
 * @param {object} post
 * @param {string} sourceId
 */
function mapPost(post, sourceId) {
  const rawId = String(post?.id ?? '');
  const original = post?.path || '';
  if (!rawId || !original) return null;
  const { width, height } = post.dimension_x
    ? { width: post.dimension_x, height: post.dimension_y }
    : parseResolution(post.resolution);
  return {
    illustId: qualifyId(sourceId, rawId),
    source: sourceId,
    title: '',             // Wallhaven 没有标题/标签体系
    author: '',
    authorName: '',
    authorAccount: '',
    authorId: '',          // 无作者 id：关注按钮与作者页点击自然隐藏（均以 authorId 为守卫）
    authorAvatar: '',
    thumbnailUrl: post.thumbs?.small || '',
    // Wallhaven 的缩略图是固定比例的裁剪：small 恒为 300×200（3:2）、lg 实测也是
    // 裁过的（432×243），thumbs.original 只有 300px 宽——三者都没法当详情页的等比中图。
    // 所以中图直接给原图：宁可多下点流量，也不能拿一张裁剪图冒充等比图。
    mediumUrl: original,
    originalUrl: original,
    tags: [],
    pixivUrl: '',          // 非 Pixiv 来源不伪造 pixiv 链接，外链一律走 webUrl
    webUrl: `https://wallhaven.cc/w/${rawId}`,
    pageCount: 1,
    type: 'image',
    illustType: 0,
    width,
    height,
    rating: post.purity || '',
    score: post.favorites || 0,
    _pageIndex: 0,
  };
}

/**
 * 创建一个 Wallhaven 来源。
 * @param {{id:string, net:object}} def — registry 里的来源定义
 */
export function createWallhavenSource(def) {
  const sourceId = def.id;
  const transport = createTransport({
    apiPrefix: def.net.apiPrefix,
    origin: def.net.apiOrigin,
    logName: `booru:${sourceId}`,
    userAgent: def.net.userAgent,
  });

  /** 取一页条目（响应统一是 { data, meta }，只用得上 data） */
  async function listPage(pathname) {
    const data = await transport(pathname);
    return Array.isArray(data?.data) ? data.data : [];
  }

  /** 排序参数 → 查询串片段（search 端点用） */
  function searchQuery({ q = '', sorting = 'date_added', safeOnly = false } = {}) {
    const params = new URLSearchParams({
      categories: CATEGORIES,
      purity: safeOnly ? SAFE_PURITY : ALL_PURITY,
      sorting,
      order: 'desc',
    });
    if (q) params.set('q', q);
    return params;
  }

  return {
    id: sourceId,
    def,
    rankingModes: TOP_RANGES.map(r => ({ key: r, label: TOP_RANGE_LABELS[r] })),

    /**
     * 关键词 / ID 搜索。带关键词时按相关度排（Wallhaven 的默认是 date_added，对搜索没用）。
     * @returns {Promise<{images: object[], query: string, error?: string}>}
     */
    async search(query, { page = 1, limit = 20, safeOnly = false } = {}) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return { images: [], query: '' };
      const id = extractWallhavenId(trimmed);
      try {
        // 链接形态走单图端点（search 没有 id 过滤参数）
        if (id) {
          const data = await transport(`/api/v1/w/${encodeURIComponent(id)}`);
          const item = mapPost(data?.data, sourceId);
          return { images: item ? [item] : [], query: trimmed, total: item ? 1 : 0 };
        }
        const params = searchQuery({ q: trimmed, sorting: 'relevance', safeOnly });
        params.set('page', String(page));
        const items = await listPage(`/api/v1/search?${params}`);
        // Wallhaven 每页固定 24 条，不接受 limit 参数 —— 这里本地夹到调用方要的数量
        return { images: items.slice(0, limit).map(p => mapPost(p, sourceId)).filter(Boolean), query: trimmed };
      } catch (e) {
        log.error('[search] 失败:', e?.message || e);
        return { images: [], query: trimmed, error: classifyError(e, '搜索') };
      }
    },

    /**
     * 推荐流 —— sorting=hot（站点热度）。
     * 注：seed 参数实测对匿名无效（同 seed 两次结果不同），所以不能用稳定的随机流。
     * @returns {Promise<{illusts: object[], message?: string}>}
     */
    async feed({ page = 1, limit = 20, safeOnly = false } = {}) {
      try {
        const params = searchQuery({ sorting: 'hot', safeOnly });
        params.set('page', String(page));
        const items = await listPage(`/api/v1/search?${params}`);
        return { illusts: items.slice(0, limit).map(p => mapPost(p, sourceId)).filter(Boolean) };
      } catch (e) {
        log.error('[feed] 失败:', e?.message || e);
        return { illusts: [], message: classifyError(e, '推荐') };
      }
    },

    /**
     * 榜单 —— 走 search 端点的 sorting=toplist + topRange，档位 1d ~ 1y。
     * 注意：**没有** /api/v1/toplist 这个端点（实测 404），榜单是 search 的一种排序。
     * @param {{period?: string, limit?: number, safeOnly?: boolean}} opts
     * @returns {Promise<{illusts: object[], error?: string}>}
     */
    async popular({ period = '1d', limit = 20, safeOnly = false } = {}) {
      const range = TOP_RANGES.includes(period) ? period : TOP_RANGES[0];
      try {
        const params = searchQuery({ sorting: 'toplist', safeOnly });
        params.set('topRange', range);
        params.set('page', '1');
        const items = await listPage(`/api/v1/search?${params}`);
        return { illusts: items.slice(0, limit).map(p => mapPost(p, sourceId)).filter(Boolean) };
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
        const data = await transport(`/api/v1/w/${encodeURIComponent(id)}`);
        const item = mapPost(data?.data, sourceId);
        if (!item) return { illust: null, error: '作品未找到，可能已被删除' };
        return { illust: toIllust(item) };
      } catch (e) {
        log.error('[fetchIllust] 失败:', e?.message || e);
        return { illust: null, error: classifyError(e, '作品详情') };
      }
    },
  };
}

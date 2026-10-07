/**
 * Zerochan 适配器 — www.zerochan.net 的自有 JSON 接口（非 booru 系）。
 *
 * 与 booru 系的关键差异：
 *   - 没有 posts.json 一类的列表端点：查询词直接放在路径上（/{tag}?json=1），
 *     多 tag 用逗号连接（AND 语义），排除用 - 前缀（如 -Ecchi）；根路径 / 就是全站最新上传流
 *   - tag 名自带空格（“Hatsune Miku” 是一个 tag）→ 应用搜索框的空格原样保留，不拆词
 *   - 列表条目只给 240px avif 缩略图，大图按 tag 拼 URL（实测规则，2026-10）：
 *       600 档 https://s1.zerochan.net/{tag 空格→点}.600.{id}.jpg —— 服务端恒存 jpg，可放心拼
 *       full 档 https://static.zerochan.net/{tag 空格→点}.full.{id}.jpg —— 扩展名随原图
 *       （png 条目拼 .jpg 会 404），只作首选候选，下载回退链会自动落回 600 档
 *     精确 URL 由 fetchIllust 的单条接口补全（详情页 / 保存链路都走它）
 *   - 分级是普通 tag（Ecchi / R-18 / Explicit）：「仅安全」= 追加 - 前缀排除（含根路径，
 *     实测 /-Ecchi,-R-18,-Explicit?json=1 可用）
 *   - 没有排行榜：popular 页不支持 json → caps.ranking: false，popular 恒返回友好错误
 *   - 越界翻页返回 200 + HTML 错误页（“Page number too high”）→ 按没有更多处理
 *   - 条目大量转载自 Pixiv：source 字段填 pixivUrl，详情页出现「在 Pixiv 打开」
 */
import { createTransport } from '../api/transport.js';
import { qualifyId, rawIdOf, sourceOfId } from '../pixiv-assistant/core/utils.js';
import { createLogger } from '../utils/logger.js';
import { classifyError, extractPostId, toIllust } from './shared.js';

const log = createLogger('zerochan');

/** 列表单页上限（实测 l=100 可用） */
const MAX_LIMIT = 100;

/** 「仅安全」档追加的排除 tag —— Zerochan 的分级就是站内普通 tag，用 - 前缀排除 */
const SAFE_EXCLUDES = ['-Ecchi', '-R-18', '-Explicit'];

/** 从 source 字段抽 pixiv 作品链接（实测多为 /en/artworks/{id} 形态） */
function pixivUrlOf(post) {
  const src = String(post?.source || '');
  return /pixiv\.net\/(en\/)?artworks\/\d+/.test(src) ? src : '';
}

/**
 * 把用户查询串转成路径形态：按逗号拆段（多 tag AND），段内空格保留（tag 自带空格）。
 * 段分别编码再拼回逗号 —— 整串 encodeURIComponent 会把分隔逗号也转成 %2C，上游不认。
 */
function encodeQuery(query) {
  return String(query || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(encodeURIComponent)
    .join(',');
}

/** 「仅安全」= 在查询后追加排除 tag */
function buildQuery(query, { safeOnly } = {}) {
  const parts = [encodeQuery(query)];
  if (safeOnly) parts.push(...SAFE_EXCLUDES);
  return parts.filter(Boolean).join(',');
}

/**
 * 一条 Zerochan 条目 → 应用统一条目。
 * 列表条目只有 thumbnail / tag；详情条目有 small/medium/large/full / primary —— 一个 mapper 兼收。
 * @param {object} post
 * @param {string} sourceId
 */
function mapPost(post, sourceId) {
  const rawId = String(post?.id ?? '');
  // 缩略图：列表是 thumbnail（240 avif），详情是 medium（同 240 档）
  const thumbnailUrl = String(post?.thumbnail || post?.medium || post?.small || '');
  if (!rawId || !thumbnailUrl) return null;
  const primary = String(post?.primary || post?.tag || '').trim();
  // tag 空格→点再整体编码（括号/单引号一并转义，实测与上游返回的 URL 一致）
  const encoded = primary ? encodeURIComponent(primary.replace(/\s+/g, '.')) : '';
  // 600 档服务端恒存 jpg（png 条目也被转码），列表直拼是安全的
  const mediumUrl = post?.large
    || (encoded ? `https://s1.zerochan.net/${encoded}.600.${rawId}.jpg` : '')
    || thumbnailUrl;
  // full 档扩展名随原图，拼错靠下载回退链兜底（originalUrl 失败 → mediumUrl）
  const originalUrl = post?.full
    || (encoded ? `https://static.zerochan.net/${encoded}.full.${rawId}.jpg` : '')
    || mediumUrl;
  return {
    illustId: qualifyId(sourceId, rawId),
    source: sourceId,
    title: primary,       // primary tag 作标题（Zerochan 没有标题字段）
    author: '',           // 无作者字段：关注按钮与作者页点击自然隐藏（均以 authorId 为守卫）
    authorName: '',
    authorAccount: '',
    authorId: '',
    authorAvatar: '',
    thumbnailUrl,
    mediumUrl,
    originalUrl,
    tags: Array.isArray(post?.tags) ? post.tags : [],
    pixivUrl: pixivUrlOf(post),
    webUrl: `https://www.zerochan.net/${rawId}`,
    pageCount: 1,
    type: 'image',
    illustType: 0,
    width: post?.width || 0,
    height: post?.height || 0,
    rating: '',           // Zerochan 的分级是普通 tag，不走 rating 字段（safeOnly 已在查询层排除）
    score: 0,
    _pageIndex: 0,
  };
}

/**
 * 创建一个 Zerochan 来源。
 * @param {{id:string, net:object}} def — registry 里的来源定义
 */
export function createZerochanSource(def) {
  const sourceId = def.id;
  const transport = createTransport({
    apiPrefix: def.net.apiPrefix,
    origin: def.net.apiOrigin,
    logName: `booru:${sourceId}`,
    userAgent: def.net.userAgent,
  });

  /**
   * 取一页列表。
   * @param {string} query — 路径形态的查询串（'' = 根路径最新上传流；多段用逗号连接）
   */
  async function listPage(query, { page = 1, limit = 20 } = {}) {
    const size = Math.min(Math.max(1, limit), MAX_LIMIT);
    try {
      const data = await transport(`/${query}?json=1&s=id&l=${size}&p=${page}`);
      return Array.isArray(data?.items) ? data.items : [];
    } catch (e) {
      // 越界翻页上游返回 200 + HTML 错误页（"Page number too high"），res.json() 抛 SyntaxError
      if (e instanceof SyntaxError) return [];
      throw e;
    }
  }

  return {
    id: sourceId,
    def,
    rankingModes: [],  // 无榜单：getRankingModes 落回默认档位，popular 恒返回友好错误

    /**
     * 标签 / ID 搜索。纯数字与 zerochan.net/123 链接按 id 直查（单条端点）。
     * @returns {Promise<{images: object[], query: string, total?: number, error?: string}>}
     */
    async search(query, { page = 1, limit = 20, safeOnly = false } = {}) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return { images: [], query: '' };
      const postId = extractPostId(trimmed, /zerochan\.net\/(\d+)/i);
      try {
        if (postId) {
          const data = await transport(`/${postId}?json=1`);
          const item = mapPost(data, sourceId);
          return { images: item ? [item] : [], query: trimmed, total: 1 };
        }
        const items = await listPage(buildQuery(trimmed, { safeOnly }), { page, limit });
        return { images: items.map(p => mapPost(p, sourceId)).filter(Boolean), query: trimmed };
      } catch (e) {
        log.error('[search] 失败:', e?.message || e);
        return { images: [], query: trimmed, error: classifyError(e, '搜索') };
      }
    },

    /**
     * 推荐流 —— 全站最新上传流（根路径 + s=id）。
     * @returns {Promise<{illusts: object[], message?: string}>}
     */
    async feed({ page = 1, limit = 20, safeOnly = false } = {}) {
      try {
        const items = await listPage(buildQuery('', { safeOnly }), { page, limit });
        return { illusts: items.map(p => mapPost(p, sourceId)).filter(Boolean) };
      } catch (e) {
        log.error('[feed] 失败:', e?.message || e);
        return { illusts: [], message: classifyError(e, '推荐') };
      }
    },

    /**
     * Zerochan 的 popular 页不支持 json（实测 404）→ 诚实报错，不伪造榜单。
     * @returns {Promise<{illusts: object[], error: string}>}
     */
    async popular() {
      return { illusts: [], error: 'Zerochan 暂不支持排行榜' };
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
        const data = await transport(`/${id}?json=1`);
        const item = mapPost(data, sourceId);
        if (!item) return { illust: null, error: '作品未找到，可能已被删除' };
        return { illust: toIllust(item) };
      } catch (e) {
        log.error('[fetchIllust] 失败:', e?.message || e);
        return { illust: null, error: classifyError(e, '作品详情') };
      }
    },
  };
}

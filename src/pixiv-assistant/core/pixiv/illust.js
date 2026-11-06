/**
 * 作品相关端点：详情（带 LRU 缓存）、随机作品、相似推荐。
 */

import { pixivPageUrl, proxyThumb } from '../utils.js';
import { mapIllustItem, mapImagePages, mapAjaxPages } from './mappers.js';

const ILLUST_CACHE_MAX = 50;
const ILLUST_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

export function createIllustApi(ctx) {
    const { apiFetch, ensureCookie, classifyError, log } = ctx;

    // Illust 详情 LRU 缓存（避免重复调 API）
    const illustCache = new Map();

    function getCachedIllust(illustId) {
        const entry = illustCache.get(illustId);
        if (!entry) return null;
        if (Date.now() - entry.time > ILLUST_CACHE_TTL) {
            illustCache.delete(illustId);
            return null;
        }
        // LRU: 删除后重新插入（移到末尾）
        illustCache.delete(illustId);
        illustCache.set(illustId, entry);
        return entry.data;
    }

    function setCachedIllust(illustId, data) {
        if (illustCache.size >= ILLUST_CACHE_MAX) {
            const firstKey = illustCache.keys().next().value;
            if (firstKey) illustCache.delete(firstKey);
        }
        illustCache.set(illustId, { data, time: Date.now() });
    }

    /** 插画详情（带 LRU 缓存，5 分钟 TTL） */
    async function fetchIllust(illustId) {
        if (!illustId) return { error: '缺少 illustId' };
        // 缓存命中
        const cached = getCachedIllust(illustId);
        if (cached) return cached;
        try {
            // 带 Cookie 请求（有 Cookie 时返回 bookmarkData 供红心远端同步联动；未登录自动不带，行为不变）
            const data = await apiFetch(`/ajax/illust/${illustId}`);
            const body = data?.body;
            if (!body) return { illust: null, error: '未找到' };

            const pageCount = body.pageCount || 1;
            const userIllustUrl = body.userIllusts?.[String(illustId)]?.url
                || body.userIllusts?.[Object.keys(body.userIllusts || {})[0]]?.url;
            const page0Url = body.urls?.regular || body.urls?.small || body.urls?.thumb
                || body.url || userIllustUrl || '';
            const page0ThumbUrl = body.urls?.thumb || body.urls?.small || userIllustUrl || page0Url;
            const page0OriginalUrl = body.urls?.original || page0Url;
            const page0PreviewUrl = body.urls?.small || body.urls?.regular || page0Url;
            let pageImages = [];
            if (pageCount > 1) {
                try {
                    // 带 Cookie 请求：R-18 作品的 /pages 子请求匿名会 403，
                    // 降级到详情兜底会丢逐页宽高（未登录时 transport 自动不带，行为不变）
                    const pagesData = await apiFetch(`/ajax/illust/${illustId}/pages`);
                    pageImages = mapAjaxPages(pagesData?.body);
                } catch (pageErr) {
                    log.warn('[fetchIllust] 获取逐页尺寸失败，使用详情兜底:', pageErr?.message || pageErr);
                }
            }
            if (!pageImages.length) {
                pageImages = mapImagePages(page0Url, page0ThumbUrl, pageCount, page0OriginalUrl, page0PreviewUrl)
                    .map(img => ({ ...img, width: body.width || 0, height: body.height || 0 }));
            }

            const result = {
                illust: {
                    illustId: String(body.illustId || body.id || illustId),
                    title: body.title || body.illustTitle || '',
                    author: body.userName || body.userAccount || '',
                    authorName: body.userName || '',
                    authorAccount: body.userAccount || '',
                    authorId: String(body.userId || ''),
                    pageCount,
                    illustType: body.illustType ?? 0,
                    images: pageImages,
                    tags: (body.tags?.tags || []).map(t => t.tag || t),
                    pixivUrl: `https://www.pixiv.net/artworks/${illustId}`,
                    width: body.width || 0,
                    height: body.height || 0,
                    bookmarked: !!body.bookmarkData, // 远端收藏状态（红心同步联动）
                    bookmarkId: body.bookmarkData?.id ?? null,
                    urls: body.urls || {}, // 原始分辨率 URL 供外部使用
                },
            };
            // 写入缓存
            setCachedIllust(illustId, result);
            return result;
        } catch (e) {
            log.error('[fetchIllust] 失败:', e.message);
            return { illust: null, error: classifyError(e, '作品详情') };
        }
    }

    /** 就地修改缓存条目的 illust 字段（红心远端同步后防 5 分钟内回显旧状态） */
    function patchIllustCache(illustId, patch) {
        const entry = illustCache.get(illustId);
        if (!entry || !patch) return;
        if (!entry.data?.illust) {
            // 条目被裁剪过（无 illust 字段）：patch 会写进游离对象被丢弃，留日志好排查红心回显旧态的问题
            log.debug('[patchIllustCache] 缓存条目缺 illust，patch 未生效:', illustId, patch);
            return;
        }
        Object.assign(entry.data.illust, patch);
        // 只改数据不改 time：保留原 TTL，不续命也不提前过期
    }

    /** 随机插画（搜索 10000users入り 然后随机选一个） */
    async function randomIllust() {
        try {
            const q = encodeURIComponent('10000users入り');
            const data = await apiFetch(
                `/ajax/search/artworks/${q}?word=${q}&order=date_d&mode=safe&p=1&s_mode=s_tag&type=illust_and_ugoira&lang=zh`,
                { skipCookie: true }
            );
            const illusts = data?.body?.illust?.data || data?.body?.illustManga?.data || [];
            if (!illusts.length) return { illust: null, error: 'no results' };

            const r = illusts[Math.floor(Math.random() * Math.min(illusts.length, 30))];
            const id = String(r.illustId || r.id);
            const pageCount = r.pageCount || 1;
            const page0Url = r.url || '';

            return {
                illust: {
                    illustId: id,
                    title: r.title || r.illustTitle || '',
                    author: r.userName || r.userAccount || '',
                    authorName: r.userName || '',
                    authorAccount: r.userAccount || '',
                    authorId: String(r.userId || ''),
                    pageCount,
                    illustType: r.illustType ?? 0,
                    images: Array.from({ length: Math.min(pageCount, 6) }, (_, p) => ({
                        index: p,
                        url: pixivPageUrl(page0Url, p),
                        thumbnailUrl: p === 0 ? proxyThumb(page0Url) : pixivPageUrl(page0Url, p),
                    })),
                    tags: (r.tags || []),
                    pixivUrl: `https://www.pixiv.net/artworks/${id}`,
                },
            };
        } catch (e) {
            log.error('[randomIllust] 失败:', e.message);
            return { illust: null, error: classifyError(e, '随机作品') };
        }
    }

    /** 相似推荐 — 根据 illustId 获取相关作品 */
    async function fetchRelated(illustId, opts = {}) {
        const { limit = 30, start = 0 } = opts;
        if (!illustId) return { illusts: [], error: '缺少 illustId' };

        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { illusts: [], error: cookieCheck.error, message: cookieCheck.message };

        try {
            const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
            const data = await apiFetch(
                `/ajax/illust/${illustId}/recommend/init?limit=${limit}&start=${start}&lang=zh`,
                { headers, timeout: 15000 }
            );

            const rawIllusts = data?.body?.illusts || [];
            const illusts = rawIllusts.map(mapIllustItem);
            return { illusts, start, limit };
        } catch (e) {
            log.error('[fetchRelated] 失败:', e.message);
            return { illusts: [], error: classifyError(e, '相似推荐') };
        }
    }

    return { fetchIllust, patchIllustCache, randomIllust, fetchRelated, getCachedIllust };
}
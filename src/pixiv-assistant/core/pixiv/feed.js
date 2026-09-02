/**
 * 信息流端点：每日推荐、收藏夹、关注画师最新作品。
 */

import { extractUserIdFromCookie, pixivReUrl, proxyThumb } from '../utils.js';
import { mapIllustItem } from './mappers.js';

export function createFeedApi(ctx) {
    const { apiFetch, ensureCookie, classifyError, log } = ctx;

    /** 每日推荐 */
    async function fetchDiscovery(opts = {}) {
        const { limit = 10, start = 0 } = opts;
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { illusts: [], error: cookieCheck.error, message: cookieCheck.message };

        try {
            const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
            const data = await apiFetch(
                `/ajax/discovery/artworks?mode=all&limit=${limit}&start=${start}&lang=zh`,
                { headers }
            );

            const rawIllusts = data?.body?.illusts || data?.body?.thumbnails?.illust || [];
            const illusts = rawIllusts.map(mapIllustItem);
            log.warn('[discovery] start:', start, 'count:', illusts.length, 'apiError:', data?.error);
            return { illusts, recommendMethods: data?.body?.recommendMethods || [], hasCookie: true };
        } catch (e) {
            log.error('[fetchDiscovery] 失败:', e?.message || e);
            return { illusts: [], error: classifyError(e, '每日推荐') };
        }
    }

    /** 收藏夹 */
    async function fetchBookmarks(opts = {}) {
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { error: cookieCheck.error, message: cookieCheck.message };

        const { tag = '', offset = 0, limit = 48 } = opts;

        try {
            const userId = extractUserIdFromCookie(cookieCheck.cookie);
            if (!userId) return { error: 'auth_failed', message: 'Cookie 格式无效，应为 {userId}_{token}' };

            const params = new URLSearchParams({ tag, offset: String(offset), limit: String(limit), rest: 'show' });
            const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
            const data = await apiFetch(
                `/ajax/user/${userId}/illusts/bookmarks?${params}`,
                { headers, timeout: 15000 }
            );

            const works = (data?.body?.works || []).map(item => ({
                illustId: String(item.id || item.illustId || ''),
                title: item.title || item.illustTitle || '',
                author: item.userName || item.userAccount || '',
                authorName: item.userName || '',
                authorAccount: item.userAccount || '',
                authorAvatar: proxyThumb(item.profileImageUrl || ''),
                authorId: String(item.userId || ''),
                thumbnailUrl: proxyThumb(item.url || ''),
                mediumUrl: pixivReUrl(String(item.id || item.illustId)),
                originalUrl: item.originalUrl || pixivReUrl(String(item.id || item.illustId)),
                tags: (item.tags || []),
                pixivUrl: `https://www.pixiv.net/artworks/${item.id || item.illustId}`,
                pageCount: item.pageCount || 1,
                illustType: item.illustType ?? 0,
            }));

            return {
                userId: String(userId),
                total: data?.body?.total || 0,
                offset,
                works,
            };
        } catch (e) {
            log.error('[fetchBookmarks] 失败:', e.message);
            return { error: 'fetch_failed', message: classifyError(e, '收藏夹') };
        }
    }

    /** 关注画师最新作品 */
    async function fetchFollowing(opts = {}) {
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { error: cookieCheck.error, message: cookieCheck.message };

        const { page = 1 } = opts;
        try {
            const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
            const data = await apiFetch(
                `/ajax/follow_latest/illust?mode=all&p=${page}&lang=zh`,
                { headers, timeout: 15000 }
            );

            const rawIllusts = data?.body?.illusts || data?.body?.thumbnails?.illust || [];
            return {
                page,
                illusts: rawIllusts.map(mapIllustItem),
            };
        } catch (e) {
            log.error('[fetchFollowing] 失败:', e.message);
            return { illusts: [], error: classifyError(e, '关注列表') };
        }
    }

    return { fetchDiscovery, fetchBookmarks, fetchFollowing };
}
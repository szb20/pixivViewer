/**
 * 作者相关端点：作者作品列表、全部作品 ID、作者资料。
 */

import { pixivReUrl, proxyThumb } from '../utils.js';

export function createUserApi(ctx) {
    const { apiFetch, ensureCookie, classifyError, log } = ctx;

    /** 作者作品列表 */
    async function fetchUserIllusts(userId, opts = {}) {
        const { limit = 30 } = opts;
        if (!userId) return { illusts: [], error: '缺少 userId' };

        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { illusts: [], error: cookieCheck.error, message: cookieCheck.message };

        try {
            const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
            // profile/all 只返回作品 ID（值多为 null），无法拿到可加载的缩略图；
            // profile/top 返回带真实 url/title 的近期作品，缩略图可正常加载（经实测）
            const data = await apiFetch(
                `/ajax/user/${userId}/profile/top?lang=zh`,
                { headers }
            );

            const illusts = Object.entries(data?.body?.illusts || {})
                .filter(([, item]) => item && item.url)
                .sort((a, b) => Number(b[0]) - Number(a[0]))
                .slice(0, limit)
                .map(([id, item]) => ({
                    illustId: String(item.id || id),
                    title: item.title || '',
                    author: item.userName || '',
                    authorName: item.userName || '',
                    authorAccount: item.userAccount || '',
                    authorId: String(userId),
                    thumbnailUrl: proxyThumb(item.url),
                    mediumUrl: proxyThumb(item.url),
                    originalUrl: pixivReUrl(String(item.id || id)),
                    tags: item.tags || [],
                    pixivUrl: `https://www.pixiv.net/artworks/${item.id || id}`,
                    pageCount: item.pageCount || 1,
                    type: item.illustType === 2 ? 'gif' : 'image',
                    illustType: item.illustType ?? 0,
                }));
            return { illusts, hasCookie: true };
        } catch (e) {
            log.error('[fetchUserIllusts] 失败:', e.message);
            return { illusts: [], error: classifyError(e, '作者作品') };
        }
    }

    /** 作者全部作品 ID（profile/all 只返回 ID，元数据需另行取，供分页/无限滚动用） */
    async function fetchUserIllustIds(userId) {
        if (!userId) return { illustIds: [], error: '缺少 userId' };
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { illustIds: [], error: cookieCheck.error, message: cookieCheck.message };
        try {
            const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
            const data = await apiFetch(`/ajax/user/${userId}/profile/all?lang=zh`, { headers });
            return { illustIds: Object.keys(data?.body?.illusts || {}) };
        } catch (e) {
            log.error('[fetchUserIllustIds] 失败:', e.message);
            return { illustIds: [], error: classifyError(e, '作者作品') };
        }
    }

    /** 作者资料（头像/账号）— 详情页作者头像用；illust 接口不返回头像，需单独请求 */
    async function fetchUserProfile(userId) {
        if (!userId) return { profile: null, error: '缺少 userId' };
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { error: cookieCheck.error, message: cookieCheck.message };
        try {
            const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
            const data = await apiFetch(`/ajax/user/${userId}?lang=zh`, { headers, timeout: 15000 });
            const body = data?.body;
            if (!body) return { profile: null, error: '未找到' };
            const bg = typeof body.background === 'string' ? body.background : (body.background?.url || '');
            return {
                profile: {
                    userId: String(body.userId || userId),
                    name: body.name || '',
                    account: body.account || '',
                    avatar: proxyThumb(body.imageBig || body.image || ''),
                    background: proxyThumb(bg),
                    isFollowed: body.isFollowed === true,
                    premium: body.premium === true,
                },
            };
        } catch (e) {
            log.error('[fetchUserProfile] 失败:', e.message);
            return { profile: null, error: classifyError(e, '作者资料') };
        }
    }

    return { fetchUserIllusts, fetchUserIllustIds, fetchUserProfile };
}
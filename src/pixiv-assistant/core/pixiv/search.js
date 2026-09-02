/**
 * 搜索端点：按标签/作品 ID 搜作品、搜用户。
 */

import { mapIllustItem } from './mappers.js';

export function createSearchApi(ctx) {
    const { apiFetch, classifyError, log, fetchIllust } = ctx;

    /** 图片搜索 — 纯数字/作品链接按 ID 直查，其余走标签搜索 */
    async function searchPixiv(query, opts = {}) {
        const { page = 1, count = 10 } = opts;
        const trimmed = query?.trim();
        if (!trimmed) return { images: [], query: '' };

        // 作品 ID（纯数字 ≥6 位）或 pixiv 作品链接 → 直接抓取单条
        const urlId = trimmed.match(/pixiv\.net\/artworks\/(\d+)/i)?.[1];
        const bareId = /^\d{6,}$/.test(trimmed) ? trimmed : '';
        const illustId = urlId || bareId;
        if (illustId) {
            const r = await fetchIllust(illustId);
            if (r?.illust) {
                const i = r.illust;
                const page0 = i.images?.[0] || {};
                return {
                    images: [mapIllustItem({
                        illustId: i.illustId,
                        title: i.title,
                        userName: i.authorName,
                        userAccount: i.authorAccount,
                        userId: i.authorId,
                        url: page0.thumbnailUrl || page0.url || '',
                        tags: i.tags || [],
                        pageCount: i.pageCount || 1,
                        illustType: i.illustType ?? 0,
                        width: i.width || 0,
                        height: i.height || 0,
                    })],
                    query: trimmed,
                    total: 1,
                };
            }
            return { images: [], query: trimmed, error: r?.error || '未找到该作品' };
        }

        try {
            const encoded = encodeURIComponent(trimmed);
            const data = await apiFetch(
                `/ajax/search/artworks/${encoded}?word=${encoded}&order=date_d&mode=safe&p=${page}&s_mode=s_tag&type=illust_and_ugoira&lang=zh`,
                { skipCookie: true }
            );
            const illusts = data?.body?.illust?.data || data?.body?.illustManga?.data || [];
            const images = illusts.slice(0, count).map(mapIllustItem);
            return { images, query: trimmed, total: data?.body?.illust?.total || illusts.length };
        } catch (e) {
            log.error('[searchPixiv] 失败:', e.message);
            return { images: [], query: trimmed, error: classifyError(e, '搜索') };
        }
    }

    /** 搜索用户 */
    async function searchPixivUser(keyword) {
        if (!keyword?.trim()) return { users: [] };
        try {
            const encoded = encodeURIComponent(keyword.trim());
            const data = await apiFetch(
                `/ajax/search/user/${encoded}?word=${encoded}&order=date&mode=safe&p=1&s_mode=s_tag&lang=zh`,
                { skipCookie: true }
            );
            const users = (data?.body?.userData?.users || data?.body?.users || []).slice(0, 5).map(u => ({
                userId: String(u.userId || u.id || ''),
                name: u.userName || u.name || '',
                account: u.userAccount || u.account || '',
                avatar: u.profileImageUrl || u.userImage || '',
                worksCount: u.illustCount || u.worksCount || 0,
            }));
            return { users };
        } catch (e) {
            log.error('[searchPixivUser] 失败:', e.message);
            return { users: [], error: classifyError(e, '搜索用户') };
        }
    }

    return { searchPixiv, searchPixivUser };
}
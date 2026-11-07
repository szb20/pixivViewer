/**
 * 收藏端点：作品收藏/取消收藏（带 CSRF token + 失败重试）。
 * 与 social.js 的关注共用 /bookmark_add.php，仅 type 不同（illust vs user）。
 */

import { isCsrfRetryable } from './client.js';

export function createBookmarkApi(ctx) {
    const { apiFetch, ensureCookie, getCsrfToken, invalidateCsrfToken, getCachedIllust, classifyError, log } = ctx;

    const formHeaders = (cookie) => ({
        'Cookie': `PHPSESSID=${cookie}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    });

    /** 收藏作品（POST /bookmark_add.php，mode=add&type=illust，与关注同端点不同 type） */
    async function bookmarkIllust(illustId, { restrict = 'public' } = {}) {
        if (!illustId) return { success: false, error: '缺少 illustId' };
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { success: false, error: cookieCheck.error, message: cookieCheck.message };
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const token = await getCsrfToken();
                const body = new URLSearchParams({
                    mode: 'add',
                    type: 'illust',
                    id: String(illustId),
                    tag: '',
                    restrict: restrict === 'private' ? '1' : '0',
                    format: 'json',
                }).toString();
                // 实测 2026-04 起 /bookmark_add.php 成功时也返回跳转页 HTML 而非 JSON
                // （即使带 format=json，收藏实际已写入）→ raw 取回不解析，
                // 改为回查作品详情：bookmarkData 出现即成功，顺带取回 bookmark_id。
                await apiFetch('/bookmark_add.php', {
                    method: 'POST',
                    body,
                    headers: { ...formHeaders(cookieCheck.cookie), 'x-csrf-token': token },
                    timeout: 15000,
                    raw: true,
                });
                const detail = await apiFetch(`/ajax/illust/${illustId}`, {
                    headers: { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` },
                    timeout: 15000,
                });
                const bookmarkId = detail?.body?.bookmarkData?.id;
                if (bookmarkId) return { success: true, bookmarkId };
                // 详情里没出现收藏记录：可能 token 失效导致 POST 被 Pixiv 吞掉
                //（其 HTML 响应无从分辨成败），换 token 重试一次
                if (attempt === 0) {
                    invalidateCsrfToken();
                    continue;
                }
                return { success: false, error: '收藏失败：Pixiv 未记录该收藏' };
            } catch (e) {
                if (attempt === 0 && isCsrfRetryable(e)) {
                    // token 可能已失效：清缓存强制重取后重试一次
                    invalidateCsrfToken();
                    continue;
                }
                log.error('[bookmarkIllust] 失败:', e.message);
                return { success: false, error: classifyError(e, '收藏') };
            }
        }
        return { success: false, error: '收藏失败' };
    }

    /** 取消收藏：两步——先带 Cookie 查详情拿 bookmarkData.id，再删（独立请求，不复用 fetchIllust：其缓存会裁剪字段） */
    async function unbookmarkIllust(illustId) {
        if (!illustId) return { success: false, error: '缺少 illustId' };
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { success: false, error: cookieCheck.error, message: cookieCheck.message };

        // ① 拿 bookmark_id；作品已不在收藏夹 → 幂等成功。
        // 先读详情 LRU 缓存（patchIllustCache 同步后维护着 bookmarkId）：
        //   - 缓存里有 id → 直接用，省一次详情请求
        //   - 缓存说已收藏但没存 id（点赞同步只置了 bookmarked）→ 拉详情补 id
        //   - 缓存明确说未收藏 → 幂等成功，无需请求
        let bookmarkId = null;
        const cachedIllust = typeof getCachedIllust === 'function'
            ? getCachedIllust(illustId)?.illust
            : null;
        if (cachedIllust && !cachedIllust.bookmarked) return { success: true, already: true };
        if (cachedIllust?.bookmarkId) {
            bookmarkId = cachedIllust.bookmarkId;
        } else {
            try {
                const detail = await apiFetch(`/ajax/illust/${illustId}`, {
                    headers: { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` },
                    timeout: 15000,
                });
                bookmarkId = detail?.body?.bookmarkData?.id;
            } catch (e) {
                log.error('[unbookmarkIllust] 查详情失败:', e.message);
                return { success: false, error: classifyError(e, '取消收藏') };
            }
        }
        if (!bookmarkId) return { success: true, already: true };

        // ② POST /ajax/illusts/bookmarks/delete
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const token = await getCsrfToken();
                const body = new URLSearchParams({ bookmark_id: String(bookmarkId) }).toString();
                const data = await apiFetch('/ajax/illusts/bookmarks/delete', {
                    method: 'POST',
                    body,
                    headers: { ...formHeaders(cookieCheck.cookie), 'x-csrf-token': token },
                    timeout: 15000,
                });
                const ok = !data || data.error !== true;
                return ok ? { success: true } : { success: false, error: data?.message || '取消收藏失败' };
            } catch (e) {
                if (attempt === 0 && isCsrfRetryable(e)) {
                    invalidateCsrfToken();
                    continue;
                }
                log.error('[unbookmarkIllust] 失败:', e.message);
                return { success: false, error: classifyError(e, '取消收藏') };
            }
        }
        return { success: false, error: '取消收藏失败' };
    }

    return { bookmarkIllust, unbookmarkIllust };
}

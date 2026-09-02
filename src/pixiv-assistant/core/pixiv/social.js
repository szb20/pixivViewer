/**
 * 社交端点：关注/取关作者（带 CSRF token + 失败重试）、我关注的作者列表。
 */

import { extractUserIdFromCookie, proxyThumb } from '../utils.js';
import { isCsrfRetryable } from './client.js';

export function createSocialApi(ctx) {
    const { apiFetch, ensureCookie, getCsrfToken, invalidateCsrfToken, classifyError, log } = ctx;

    const formHeaders = (cookie) => ({
        'Cookie': `PHPSESSID=${cookie}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    });

    /** 关注作者（真实端点：POST /bookmark_add.php，表单格式 + x-csrf-token） */
    async function followUser(userId, { restrict = 'public' } = {}) {
        if (!userId) return { success: false, error: '缺少 userId' };
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { success: false, error: cookieCheck.error, message: cookieCheck.message };
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const token = await getCsrfToken();
                const body = new URLSearchParams({
                    mode: 'add',
                    type: 'user',
                    user_id: String(userId),
                    tag: '',
                    restrict: restrict === 'private' ? '1' : '0',
                    format: 'json',
                }).toString();
                const data = await apiFetch('/bookmark_add.php', {
                    method: 'POST',
                    body,
                    headers: { ...formHeaders(cookieCheck.cookie), 'x-csrf-token': token },
                    timeout: 15000,
                });
                const ok = Array.isArray(data) || (data && data.error === false);
                return ok ? { success: true } : { success: false, error: data?.message || '关注失败' };
            } catch (e) {
                if (attempt === 0 && isCsrfRetryable(e)) {
                    // token 可能已失效：清缓存强制重取后重试一次
                    invalidateCsrfToken();
                    continue;
                }
                log.error('[followUser] 失败:', e.message);
                return { success: false, error: classifyError(e, '关注') };
            }
        }
        return { success: false, error: '关注失败' };
    }

    /** 取消关注作者（真实端点：POST /rpc_group_setting.php，表单格式 + x-csrf-token） */
    async function unfollowUser(userId) {
        if (!userId) return { success: false, error: '缺少 userId' };
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { success: false, error: cookieCheck.error, message: cookieCheck.message };
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const token = await getCsrfToken();
                const body = new URLSearchParams({ mode: 'del', type: 'bookuser', id: String(userId) }).toString();
                const data = await apiFetch('/rpc_group_setting.php', {
                    method: 'POST',
                    body,
                    headers: { ...formHeaders(cookieCheck.cookie), 'x-csrf-token': token },
                    timeout: 15000,
                });
                const ok = !!(data && data.error !== true);
                return ok ? { success: true } : { success: false, error: data?.message || '取关失败' };
            } catch (e) {
                if (attempt === 0 && isCsrfRetryable(e)) {
                    invalidateCsrfToken();
                    continue;
                }
                log.error('[unfollowUser] 失败:', e.message);
                return { success: false, error: classifyError(e, '取关') };
            }
        }
        return { success: false, error: '取关失败' };
    }

    /** 我关注的作者列表（订阅页，按关注时间倒序分页） */
    async function fetchFollowingUsers(opts = {}) {
        const cookieCheck = await ensureCookie();
        if (cookieCheck.error) return { error: cookieCheck.error, message: cookieCheck.message };

        const { offset = 0, limit = 30 } = opts;
        try {
            const userId = extractUserIdFromCookie(cookieCheck.cookie);
            if (!userId) return { error: 'auth_failed', message: 'Cookie 格式无效，应为 {userId}_{token}' };

            const params = new URLSearchParams({ offset: String(offset), limit: String(limit), rest: 'show' });
            const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
            const data = await apiFetch(
                `/ajax/user/${userId}/following?${params}&lang=zh`,
                { headers, timeout: 15000 }
            );

            const users = (data?.body?.users || []).map(u => ({
                userId: String(u.userId || u.id || ''),
                name: u.userName || u.name || '',
                account: u.userAccount || u.account || '',
                avatar: proxyThumb(u.profileImageUrl || u.image || ''),
                comment: u.comment || '',
            }));

            return {
                total: data?.body?.total || 0,
                offset,
                users,
            };
        } catch (e) {
            log.error('[fetchFollowingUsers] 失败:', e.message);
            return { users: [], error: classifyError(e, '关注作者') };
        }
    }

    return { followUser, unfollowUser, fetchFollowingUsers };
}
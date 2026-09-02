/**
 * 排行榜端点。
 */

import { mapRankingItem } from './mappers.js';

const VALID_MODES = ['daily', 'weekly', 'monthly', 'rookie', 'original', 'male', 'female',
    'daily_r18', 'weekly_r18', 'male_r18', 'female_r18', 'r18g'];

export function createRankingApi(ctx) {
    const { apiFetch, classifyError, transport, log } = ctx;

    /** 排行榜 */
    async function fetchRanking(opts = {}) {
        const { mode = 'daily', page = 1 } = opts;
        const safeMode = VALID_MODES.includes(mode) ? mode : 'daily';
        const cookie = await transport.getCookie();

        try {
            const headers = {};
            // R-18 模式需要登录
            if (cookie) headers['Cookie'] = `PHPSESSID=${cookie}`;

            const data = await apiFetch(
                `/ranking.php?format=json&mode=${safeMode}&content=all&p=${page}`,
                { headers }
            );

            const rawIllusts = data?.contents || [];
            const illusts = rawIllusts.map(mapRankingItem);
            return { illusts, mode: safeMode, page, rankTotal: illusts.length };
        } catch (e) {
            log.error('[fetchRanking] 失败:', e.message);
            return { illusts: [], error: classifyError(e, '排行榜') };
        }
    }

    return { fetchRanking };
}
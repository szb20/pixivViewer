/**
 * useStartupProxyCheck — 应用启动时检测 Pixiv 代理连通性，失败时通过回调提示。
 *
 * @param {(show: boolean, proxyUrl?: string) => void} onProxyError 代理不可达时回调
 */
import { useEffect } from 'react';
import { checkProxyReachable } from '../utils/proxyCheck.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('App');

export function useStartupProxyCheck(onProxyError) {
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { reachable, proxyUrl } = await checkProxyReachable(3000);
                if (cancelled) return;
                if (!reachable) {
                    onProxyError(true, proxyUrl);
                }
            } catch (e) {
                log.warn('启动时代理检测异常:', e?.message || e);
            }
        })();
        return () => { cancelled = true; };
    }, [onProxyError]);
}
/**
 * 代理连通性探测工具。
 *
 * 在浏览器环境中无法直接建立 TCP 连接来验证 HTTP 代理，因此采用实际请求验证：
 * - dev 模式：fetch /pixiv-api/...（经 Vite 代理隧道），短超时
 * - prod 模式：CapacitorHttp → https://www.pixiv.net，短超时
 *
 * 导出：
 *   checkProxyReachable(timeoutMs) → Promise<boolean>
 */
import { CapacitorHttp } from '@capacitor/core';
import { getSettings } from '../pixiv-assistant/index.js';
import { createLogger } from './logger.js';

const log = createLogger('proxyCheck');
const IS_DEV = import.meta.env.DEV;

/**
 * 探测代理/网络是否可达。
 * @param {number} [timeoutMs=3000] 超时毫秒
 * @returns {Promise<{reachable: boolean, proxyUrl: string}>}
 */
export async function checkProxyReachable(timeoutMs = 3000) {
  const settings = await getSettings();
  const proxyUrl = settings.proxyUrl || 'http://127.0.0.1:7890';

  try {
    if (IS_DEV) {
      // Dev 模式：通过 Vite 代理隧道请求 Pixiv API
      // 如果 Clash 没开，Vite 代理会立即返回 502 或连接拒绝
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(
          '/pixiv-api/ajax/discovery/artworks?mode=all&limit=1',
          { signal: ctrl.signal, headers: { Accept: 'application/json' } }
        );
        clearTimeout(timer);
        // 502/504 表示代理层连不上 Pixiv（代理未运行或 Pixiv 不可达）
        if (res.status === 502 || res.status === 504) {
          log.warn('代理不可达（Vite 返回', res.status, '）:', proxyUrl);
          return { reachable: false, proxyUrl };
        }
        // 其他 HTTP 状态（包括 200、403 等）都说明代理隧道通了
        return { reachable: true, proxyUrl };
      } catch (e) {
        clearTimeout(timer);
        // fetch 被 abort → timeout
        if (e.name === 'AbortError') {
          log.warn('代理探测超时:', proxyUrl);
          return { reachable: false, proxyUrl };
        }
        // Failed to fetch / NetworkError → 代理/网络不可达
        log.warn('代理不可达:', e.message);
        return { reachable: false, proxyUrl };
      }
    } else {
      // Prod 模式：直接请求 Pixiv（走系统代理/VPN）
      try {
        const resp = await CapacitorHttp.request({
          method: 'GET',
          url: 'https://www.pixiv.net/',
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs,
        });
        if (resp.status < 200 || resp.status >= 600) {
          log.warn('Pixiv 不可达（HTTP', resp.status, '）');
          return { reachable: false, proxyUrl };
        }
        return { reachable: true, proxyUrl };
      } catch (e) {
        const msg = e?.message || String(e);
        log.warn('Pixiv 网络不可达:', msg);
        return { reachable: false, proxyUrl };
      }
    }
  } catch (e) {
    log.error('代理探测异常:', e?.message || e);
    return { reachable: false, proxyUrl };
  }
}

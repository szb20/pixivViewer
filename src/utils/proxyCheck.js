/**
 * 代理连通性探测工具。
 *
 * 在浏览器环境中无法直接建立 TCP 连接来验证 HTTP 代理，因此采用实际请求验证：
 * - dev 模式：fetch /pixiv-api/...（经 Vite 代理隧道），短超时
 * - desktop 模式：fetch 壳内代理服务（Electron main 内嵌，复用 /pixiv-api），短超时
 * - prod 模式：CapacitorHttp → https://www.pixiv.net，短超时
 *
 * 导出：
 *   checkProxyReachable(timeoutMs) → Promise<boolean>
 */
import { CapacitorHttp } from '@capacitor/core';
import { getSettings } from '../pixiv-assistant/index.js';
import { isDesktopShell, getDesktopProxyPort } from './platform.js';
import { createLogger } from './logger.js';

const log = createLogger('proxyCheck');
const IS_DEV = import.meta.env.DEV;

/**
 * 走代理隧道探测（dev= Vite / desktop= 壳内代理，判定一致：502/504 = 代理层连不上 Pixiv）。
 *
 * 探针打 Pixiv 首页，不打业务 ajax 端点：`/ajax/discovery/artworks` 之类的端点在无 Cookie 时
 * 恒返回 400（实测与 limit 无关），会在控制台留下一条红色失败请求，而探针并不需要区分它——
 * 首页无凭据同样是 200，已足以证明「隧道通、拿到了真实 HTTP 响应」。也与 prod 分支探测
 * `https://www.pixiv.net/` 保持同一语义。
 * @returns {Promise<boolean>}
 */
async function probeThroughProxy(timeoutMs) {
  try {
    let res;
    if (isDesktopShell()) {
      // desktop：直接 fetch 壳内代理（127.0.0.1:port，CORS 已由主进程处理）
      const port = await getDesktopProxyPort();
      if (!port) return false;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        res = await fetch(`http://127.0.0.1:${port}/pixiv-api/`, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    } else {
      res = await fetch('/pixiv-api/', { signal: AbortSignal.timeout(timeoutMs) });
    }
    if (res?.status === 502 || res?.status === 504) {
      log.warn('代理不可达（', res.status, '）');
      return false;
    }
    return true;
  } catch (e) {
    log.warn('代理不可达:', e?.message || e);
    return false;
  }
}

/**
 * 探测代理/网络是否可达。
 * @param {number} [timeoutMs=3000] 超时毫秒
 * @returns {Promise<{reachable: boolean, proxyUrl: string}>}
 */
export async function checkProxyReachable(timeoutMs = 3000) {
  const settings = await getSettings();
  const proxyUrl = settings.proxyUrl || 'http://127.0.0.1:7890';

  try {
    if (IS_DEV || isDesktopShell()) {
      const ok = await probeThroughProxy(timeoutMs);
      return { reachable: ok, proxyUrl };
    }
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
  } catch (e) {
    log.error('代理探测异常:', e?.message || e);
    return { reachable: false, proxyUrl };
  }
}
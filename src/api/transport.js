/**
 * 通用 HTTP 传输层 — 三条通道，与历史 Pixiv 实现逐字节等价，只是把 base 参数化。
 *
 *   dev      → Vite 代理（同源，绕 CORS）
 *   desktop  → Electron 壳内嵌代理服务（127.0.0.1:{port}）
 *   prod     → CapacitorHttp（原生 HTTP 栈，走系统代理），失败降级 fetch
 *
 * 各站点通过 createTransport 生成自己的传输实例。
 */
import { CapacitorHttp } from '@capacitor/core';
import { isDesktopShell, getDesktopProxyPort } from '../utils/platform.js';
import { createLogger } from '../utils/logger.js';

const IS_DEV = import.meta.env.DEV;
export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FORBIDDEN = new Set(['cookie', 'referer', 'user-agent']);

/**
 * 构造带 status 的 HTTP 错误（显式错误契约：上层按 err.status 分类，不再解析消息字符串）。
 */
export function httpError(status, pathname = '') {
  const e = new Error(`HTTP ${status}${pathname ? ` (${pathname})` : ''}`);
  e.status = status;
  return e;
}

/**
 * 默认头构造。
 *
 * dev / 桌面壳下浏览器禁止设置 Cookie，按 cookieAs 转成自定义头交给代理还原透传
 * （Pixiv 用 x-pixiv-cookie；booru 站不需要 Cookie，cookieAs 传 null 即可直接丢弃）。
 * prod 走 CapacitorHttp，可直设 Cookie。
 */
function makeBuildHeaders({ cookieAs = null, referer = null } = {}) {
  return function buildHeaders(headers = {}) {
    const h = {};
    for (const [key, value] of Object.entries(headers || {})) {
      if (value == null || value === '') continue;
      const lower = key.toLowerCase();
      if (lower === 'cookie') {
        if (IS_DEV || isDesktopShell()) {
          if (cookieAs) h[cookieAs] = value;
          continue;
        }
        h[key] = value; // CapacitorHttp 可以直接设 Cookie
        continue;
      }
      if (FORBIDDEN.has(lower)) continue;
      h[key] = value;
    }
    if (!IS_DEV && !isDesktopShell()) {
      if (referer) h['Referer'] = referer;
      h['User-Agent'] = DESKTOP_UA;
    }
    return h;
  };
}

/**
 * 创建一个站点的传输实例。
 *
 * 返回的函数按运行平台自动选中通道，并挂上 .devFetch / .desktopFetch / .prodFetch
 * 供需要显式指定通道的调用方使用。
 *
 * @param {object} opts
 * @param {string} opts.apiPrefix       — dev 下挂载的代理前缀，如 '/pixiv-api'
 * @param {string} opts.origin          — 生产直连的站点源，如 'https://www.pixiv.net'
 * @param {string} [opts.desktopPrefix] — 桌面壳内的代理前缀（默认同 apiPrefix）
 * @param {string} [opts.referer]       — prod 下发送的 Referer（默认 origin）
 * @param {string} [opts.cookieAs]      — dev/桌面下 Cookie 转成的自定义头名（默认 null＝丢弃）
 * @param {string} [opts.logName]       — 日志模块名
 * @returns {(pathname: string, opts?: object) => Promise<any>}
 */
export function createTransport({
  apiPrefix,
  origin,
  desktopPrefix = null,
  referer = null,
  cookieAs = null,
  logName = 'transport',
}) {
  const log = createLogger(logName);
  const desktopPath = desktopPrefix || apiPrefix;
  const buildHeaders = makeBuildHeaders({ cookieAs, referer: referer || origin });

  async function devFetch(pathname, { headers = {}, timeout, method = 'GET', body, raw = false } = {}) {
    const h = buildHeaders(headers);
    const ctrl = new AbortController();
    const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch(`${apiPrefix}${pathname}`, { method, body, headers: h, signal: ctrl.signal });
      if (!res.ok) throw httpError(res.status, pathname);
      return raw ? await res.text() : await res.json();
    } finally { if (timer) clearTimeout(timer); }
  }

  /**
   * 桌面壳：请求壳内代理服务（Electron main 进程内嵌，与 Vite dev 同款中间件）。
   * 绕开浏览器 CORS + Cookie 限制：Cookie 继续走 cookieAs 头，由代理还原透传。
   */
  async function desktopFetch(pathname, { headers = {}, timeout, method = 'GET', body, raw = false } = {}) {
    const port = await getDesktopProxyPort();
    if (!port) throw new Error('桌面代理端口不可用');
    const h = buildHeaders(headers);
    const ctrl = new AbortController();
    const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${desktopPath}${pathname}`, {
        method, body, headers: h, signal: ctrl.signal,
      });
      if (!res.ok) throw httpError(res.status, pathname);
      return raw ? await res.text() : await res.json();
    } finally { if (timer) clearTimeout(timer); }
  }

  async function prodFetch(pathname, { headers = {}, timeout, method = 'GET', body, raw = false } = {}) {
    const h = buildHeaders(headers);
    const url = `${origin}${pathname}`;
    try {
      const resp = await CapacitorHttp.request({
        method, url,
        headers: h,
        data: method === 'GET' ? undefined : body,
        connectTimeout: timeout || 15000,
        readTimeout: timeout || 15000,
      });
      if (resp.status < 200 || resp.status >= 300) throw httpError(resp.status, pathname);
      if (raw) return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      return typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
    } catch (e) {
      // 用结构化错误契约判断（httpError 带 status），不要解析消息字符串：
      // 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' 之类的网络错误也含 "HTTP"，
      // 曾被误判成 HTTP 错误直接上抛，丢掉了下面的 fetch 降级兜底。
      if (e?.status) throw e;
      // CapacitorHttp 失败时回退 fetch（可能直接走 WIFI 绕过代理）
      log.info('CapacitorHttp 请求失败，降级 fetch:', pathname, e.message);
      const ctrl = new AbortController();
      const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
      try {
        const res = await fetch(url, { method, body, headers: h, signal: ctrl.signal });
        if (!res.ok) throw httpError(res.status, pathname);
        return raw ? await res.text() : await res.json();
      } finally { if (timer) clearTimeout(timer); }
    }
  }

  const fetch_ = isDesktopShell() ? desktopFetch : (IS_DEV ? devFetch : prodFetch);
  fetch_.devFetch = devFetch;
  fetch_.desktopFetch = desktopFetch;
  fetch_.prodFetch = prodFetch;
  return fetch_;
}

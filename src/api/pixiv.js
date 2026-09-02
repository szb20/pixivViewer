/**
 * Pixiv API 适配层 — dev 走 Vite 代理，desktop 走壳内代理服务，prod 走 CapacitorHttp（手机系统代理）。
 */
import { CapacitorHttp } from '@capacitor/core';
import { createPixivApi, getSettings } from '../pixiv-assistant/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('pixivFetch');

const IS_DEV = import.meta.env.DEV;
const PIXIV_BASE = 'https://www.pixiv.net';
const FORBIDDEN = new Set(['cookie', 'referer', 'user-agent']);

/** 桌面壳：window.desktopProxy 由 Electron preload 注入 */
export function isDesktopShell() {
  return typeof window !== 'undefined' && !!window.desktopProxy;
}

let _proxyPortPromise = null;
/** 懒加载壳内代理端口（一次性获取并缓存） */
function getProxyPort() {
  if (!_proxyPortPromise) {
    _proxyPortPromise = window.desktopProxy.getPort().catch((e) => {
      log.warn('获取桌面代理端口失败:', e?.message || e);
      _proxyPortPromise = null; // 允许下次重试
      return 0;
    });
  }
  return _proxyPortPromise;
}

/** 供代理探测等外部复用壳内代理端口（拿不到返回 0） */
export function getDesktopProxyPort() {
  return getProxyPort();
}

function buildHeaders(headers = {}) {
  const h = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null || value === '') continue;
    const lower = key.toLowerCase();
    // 浏览器/桌面壳禁止设置 Cookie，转为 x-pixiv-cookie 由代理（Vite / 壳内服务）透传
    if (lower === 'cookie') {
      if (IS_DEV || isDesktopShell()) { h['x-pixiv-cookie'] = value; continue; }
      // Prod: CapacitorHttp 可以直接设 Cookie
      h[key] = value; continue;
    }
    if (FORBIDDEN.has(lower)) continue;
    h[key] = value;
  }
  if (!IS_DEV && !isDesktopShell()) {
    h['Referer'] = PIXIV_BASE;
    h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  }
  return h;
}

async function devFetch(pathname, { headers = {}, timeout, method = 'GET', body, raw = false } = {}) {
  const h = buildHeaders(headers);
  const ctrl = new AbortController();
  const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
  try {
    const res = await fetch(`/pixiv-api${pathname}`, { method, body, headers: h, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return raw ? await res.text() : await res.json();
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * 桌面壳：请求壳内代理服务（Electron main 进程内嵌，与 Vite dev 同款中间件）。
 * 绕开浏览器 CORS + Cookie 限制：Cookie 继续走 x-pixiv-cookie 头，由代理还原透传。
 */
async function desktopFetch(pathname, { headers = {}, timeout, method = 'GET', body, raw = false } = {}) {
  const port = await getProxyPort();
  if (!port) throw new Error('桌面代理端口不可用');
  const h = buildHeaders(headers);
  const ctrl = new AbortController();
  const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/pixiv-api${pathname}`, {
      method, body, headers: h, signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return raw ? await res.text() : await res.json();
  } finally { if (timer) clearTimeout(timer); }
}

async function prodFetch(pathname, { headers = {}, timeout, method = 'GET', body, raw = false } = {}) {
  const h = buildHeaders(headers);
  const url = `${PIXIV_BASE}${pathname}`;
  try {
    const resp = await CapacitorHttp.request({
      method, url,
      headers: h,
      data: method === 'GET' ? undefined : body,
      connectTimeout: timeout || 15000,
      readTimeout: timeout || 15000,
    });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
    if (raw) return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    return typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
  } catch (e) {
    if (e.message?.includes('HTTP')) throw e;
    // CapacitorHttp 失败时回退 fetch（可能直接走 WIFI 绕过代理）
    log.info('CapacitorHttp 请求失败，降级 fetch:', pathname, e.message);
    const ctrl = new AbortController();
    const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch(url, { method, body, headers: h, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return raw ? await res.text() : await res.json();
    } finally { if (timer) clearTimeout(timer); }
  }
}

async function getCookie() {
  const s = await getSettings();
  return String(s.pixivCookie || '').trim().replace(/^PHPSESSID=/i, '');
}

export { devFetch as browserFetch, prodFetch, desktopFetch };

export const pixivApi = createPixivApi({
  fetch: isDesktopShell() ? desktopFetch : (IS_DEV ? devFetch : prodFetch),
  getCookie,
});

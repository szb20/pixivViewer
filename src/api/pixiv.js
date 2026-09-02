/**
 * Pixiv API 适配层 — dev 走 Vite 代理，prod 走 CapacitorHttp（手机系统代理）。
 */
import { CapacitorHttp } from '@capacitor/core';
import { createPixivApi, getSettings } from '../pixiv-assistant/index.js';
import { createLogger } from '../utils/logger.js';
import { isDesktop, desktop } from '../utils/platform.js';

const log = createLogger('pixivFetch');

const IS_DEV = import.meta.env.DEV;
const PIXIV_BASE = 'https://www.pixiv.net';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const FORBIDDEN = new Set(['cookie', 'referer', 'user-agent']);

function buildHeaders(headers = {}) {
  const h = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null || value === '') continue;
    const lower = key.toLowerCase();
    // Dev: 浏览器禁止设置 Cookie，转为 x-pixiv-cookie 由 Vite 代理透传
    if (lower === 'cookie') {
      if (IS_DEV) { h['x-pixiv-cookie'] = value; continue; }
      // Prod: CapacitorHttp 可以直接设 Cookie
      h[key] = value; continue;
    }
    if (FORBIDDEN.has(lower)) continue;
    h[key] = value;
  }
  if (!IS_DEV) {
    h['Referer'] = PIXIV_BASE;
    h['User-Agent'] = DESKTOP_UA;
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

/**
 * 桌面端（Electron）：走主进程 Node HTTP（带 Clash 代理 + 自定义 UA/Referer/Cookie），
 * 天然绕过浏览器 CORS，与安卓 CapacitorHttp 等价。
 */
async function desktopFetch(pathname, { headers = {}, timeout, method = 'GET', body, raw = false } = {}) {
  // 桌面桥是 Node 直连，可自由设置 Cookie/Referer/UA（无浏览器禁头限制），
  // 因此不论是否加载 Vite dev server，都按生产方式构造头。
  const h = { ...headers, Referer: PIXIV_BASE, 'User-Agent': DESKTOP_UA };
  const url = pathname.startsWith('http') ? pathname : `${PIXIV_BASE}${pathname}`;
  const resp = await desktop.http.request({
    url, method, headers: h, data: method === 'GET' ? undefined : body,
    timeout: timeout || 15000,
  });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
  if (raw) return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  return typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
}

export { devFetch as browserFetch, prodFetch, desktopFetch };

// 传输选择：桌面 Electron 主进程 > 生产安卓 CapacitorHttp > dev/浏览器 Vite 代理
const activeFetch = isDesktop ? desktopFetch : IS_DEV ? devFetch : prodFetch;

export const pixivApi = createPixivApi({ fetch: activeFetch, getCookie });
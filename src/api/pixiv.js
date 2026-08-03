/**
 * Pixiv API 适配层 — dev 走 Vite 代理，prod 走 CapacitorHttp（手机系统代理）。
 */
import { CapacitorHttp } from '@capacitor/core';
import { createPixivApi, getSettings } from '../pixiv-assistant/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('pixivFetch');

const IS_DEV = import.meta.env.DEV;
const PIXIV_BASE = 'https://www.pixiv.net';
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
    h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  }
  return h;
}

async function devFetch(pathname, { headers = {}, timeout } = {}) {
  const h = buildHeaders(headers);
  const ctrl = new AbortController();
  const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
  try {
    const res = await fetch(`/pixiv-api${pathname}`, { headers: h, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { if (timer) clearTimeout(timer); }
}

async function prodFetch(pathname, { headers = {}, timeout } = {}) {
  const h = buildHeaders(headers);
  const url = `${PIXIV_BASE}${pathname}`;
  try {
    const resp = await CapacitorHttp.request({
      method: 'GET', url,
      headers: h,
      connectTimeout: timeout || 15000,
      readTimeout: timeout || 15000,
    });
    if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
    return typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
  } catch (e) {
    if (e.message?.includes('HTTP')) throw e;
    // CapacitorHttp 失败时回退 fetch（可能直接走 WIFI 绕过代理）
    log.info('CapacitorHttp 请求失败，降级 fetch:', pathname, e.message);
    const ctrl = new AbortController();
    const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch(url, { headers: h, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { if (timer) clearTimeout(timer); }
  }
}

async function getCookie() {
  const s = await getSettings();
  return String(s.pixivCookie || '').trim().replace(/^PHPSESSID=/i, '');
}

export { devFetch as browserFetch };

export const pixivApi = createPixivApi({ fetch: IS_DEV ? devFetch : prodFetch, getCookie });

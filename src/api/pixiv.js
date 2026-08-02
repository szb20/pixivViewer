/**
 * 浏览器 API 适配层 — 走 Vite 开发代理（/pixiv-api）。
 * 浏览器禁止设置 Cookie/Referer/User-Agent 头，
 * 代理约定用 x-pixiv-cookie 传递 PHPSESSID，Referer/UA 由代理统一添加。
 */
import { createPixivApi, getSettings } from '../pixiv-assistant/index.js';

const FORBIDDEN = new Set(['cookie', 'referer', 'user-agent']);

async function browserFetch(pathname, { headers = {}, timeout } = {}) {
  const h = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null || value === '') continue;
    const lower = key.toLowerCase();
    if (lower === 'cookie') {
      h['x-pixiv-cookie'] = value;
      continue;
    }
    if (FORBIDDEN.has(lower)) continue;
    h[key] = value;
  }

  const ctrl = new AbortController();
  const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : null;
  try {
    const res = await fetch(`/pixiv-api${pathname}`, { headers: h, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getCookie() {
  const s = await getSettings();
  return String(s.pixivCookie || '').trim().replace(/^PHPSESSID=/i, '');
}

export const pixivApi = createPixivApi({ fetch: browserFetch, getCookie });

/**
 * 非 Pixiv 图站代理 — 复用 proxy-utils 的通用中间件转发到各图站。
 *
 * Vite dev server 与 Electron 壳内代理服务共用这一份路由表，避免两边漂移。
 * ⚠️ 这里的路由必须与 src/sources/registry.js 的 net 配置保持一致
 *    （前缀、目标 host、userAgent 三样都要对齐）。
 *
 * 实测：图床本身没有防盗链，但多数站的 API 不返回 CORS 头，浏览器里必须走同源代理。
 */
import { createApiProxy, createImageProxy, createH2Proxy } from './proxy-utils.mjs';
import { API_CLIENT_UA } from '../src/sources/shared.js';

/**
 * 路由表。prefix → 目标 host。
 * 图片路由的 Referer 设为目标域自身：这些图床不校验 Referer，白送站点页的假 Referer 反而奇怪。
 *
 * userAgent：Danbooru 系（含 cdn.donmai.us）与 Wallhaven 在 Cloudflare 后面，
 * 浏览器 UA 会吃到 JS 挑战，必须声明非浏览器 UA（实测见 src/sources/shared.js）。
 *
 * http2：hypnohub / xbooru 在应用层强制 HTTP/2 —— TLS 能握手，但 HTTP/1.1 请求
 * 一律挂起不响应（浏览器默认 h2 所以无感）。这类路由走 createH2Proxy。
 */
export const BOORU_ROUTES = [
  { prefix: '/yande-api', target: 'https://yande.re', kind: 'api' },
  { prefix: '/yande-img', target: 'https://files.yande.re', kind: 'img' },
  { prefix: '/yande-thumb', target: 'https://assets.yande.re', kind: 'img' },
  { prefix: '/konachan-api', target: 'https://konachan.com', kind: 'api' },
  { prefix: '/konachan-img', target: 'https://konachan.com', kind: 'img' },
  { prefix: '/konachan-net-api', target: 'https://konachan.net', kind: 'api' },
  { prefix: '/konachan-net-img', target: 'https://konachan.net', kind: 'img' },
  { prefix: '/danbooru-api', target: 'https://danbooru.donmai.us', kind: 'api', userAgent: API_CLIENT_UA },
  { prefix: '/danbooru-img', target: 'https://cdn.donmai.us', kind: 'img', userAgent: API_CLIENT_UA },
  { prefix: '/safebooru-api', target: 'https://safebooru.org', kind: 'api' },
  { prefix: '/safebooru-img', target: 'https://safebooru.org', kind: 'img' },
  { prefix: '/wallhaven-api', target: 'https://wallhaven.cc', kind: 'api', userAgent: API_CLIENT_UA },
  { prefix: '/wallhaven-img', target: 'https://w.wallhaven.cc', kind: 'img' },
  { prefix: '/wallhaven-thumb', target: 'https://th.wallhaven.cc', kind: 'img' },
  // safebooru-donmai 与主站同用 cdn.donmai.us 图床 → 图片复用上面的 /danbooru-img
  { prefix: '/safebooru-donmai-api', target: 'https://safebooru.donmai.us', kind: 'api', userAgent: API_CLIENT_UA },
  { prefix: '/tbib-api', target: 'https://tbib.org', kind: 'api' },
  { prefix: '/tbib-img', target: 'https://tbib.org', kind: 'img' },
  { prefix: '/sakugabooru-api', target: 'https://www.sakugabooru.com', kind: 'api' },
  { prefix: '/sakugabooru-img', target: 'https://www.sakugabooru.com', kind: 'img' },
  // Zerochan：图床按档位分三个域（600 档 s1 / 240 缩略图 s3 / full 原图 static），都在 Cloudflare 后面
  { prefix: '/zerochan-api', target: 'https://www.zerochan.net', kind: 'api', userAgent: API_CLIENT_UA },
  { prefix: '/zerochan-s1-img', target: 'https://s1.zerochan.net', kind: 'img', userAgent: API_CLIENT_UA },
  { prefix: '/zerochan-s3-img', target: 'https://s3.zerochan.net', kind: 'img', userAgent: API_CLIENT_UA },
  { prefix: '/zerochan-static-img', target: 'https://static.zerochan.net', kind: 'img', userAgent: API_CLIENT_UA },
  // hypnohub：API 与图床同域（主站），全站强制 HTTP/2
  { prefix: '/hypnohub-api', target: 'https://hypnohub.net', kind: 'api', http2: true },
  { prefix: '/hypnohub-img', target: 'https://hypnohub.net', kind: 'img', http2: true },
  // xbooru：原图在 img.xbooru.com、缩略图在主域（两条路由都强制 HTTP/2）
  { prefix: '/xbooru-api', target: 'https://xbooru.com', kind: 'api', http2: true },
  { prefix: '/xbooru-img', target: 'https://img.xbooru.com', kind: 'img', http2: true },
  { prefix: '/xbooru-thumb', target: 'https://xbooru.com', kind: 'img', http2: true },
];

/**
 * 把一条路由定义转成中间件。
 * 图片走长缓存（同 Pixiv 缩略图策略，避免滚动时重复回源）。
 * @param {{prefix:string, target:string, kind:'api'|'img', userAgent?:string, http2?:boolean}} route
 * @returns {Function} Vite / Node 中间件
 */
export function createBooruMiddleware(route) {
  // 强制 HTTP/2 的站点：走 CONNECT 隧道 + node:http2（见 proxy-utils.mjs 的 createH2Proxy）
  if (route.http2) {
    return createH2Proxy(route.target, {
      userAgent: route.userAgent,
      cacheControl: route.kind === 'img' ? 'public, max-age=604800' : undefined,
    });
  }
  if (route.kind === 'img') {
    return createImageProxy(route.target, {
      referer: route.target,
      cacheControl: 'public, max-age=604800',
      userAgent: route.userAgent,
    });
  }
  return createApiProxy(route.target, { userAgent: route.userAgent });
}

/**
 * 注册全部 booru 代理到 Vite dev server。
 * @param {import('vite').ViteDevServer} server
 */
export function registerBooruProxies(server) {
  for (const route of BOORU_ROUTES) {
    server.middlewares.use(route.prefix, createBooruMiddleware(route));
  }
}

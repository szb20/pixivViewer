/**
 * 非 Pixiv 图站代理 — 复用 proxy-utils 的通用中间件转发到各图站。
 *
 * Vite dev server 与 Electron 壳内代理服务共用这一份路由表，避免两边漂移。
 * ⚠️ 这里的路由必须与 src/sources/registry.js 的 net 配置保持一致
 *    （前缀、目标 host、userAgent 三样都要对齐）。
 *
 * 实测：图床本身没有防盗链，但多数站的 API 不返回 CORS 头，浏览器里必须走同源代理。
 */
import { createApiProxy, createImageProxy } from './proxy-utils.mjs';
import { API_CLIENT_UA } from '../src/sources/shared.js';

/**
 * 路由表。prefix → 目标 host。
 * 图片路由的 Referer 设为目标域自身：这些图床不校验 Referer，白送站点页的假 Referer 反而奇怪。
 *
 * userAgent：Danbooru 系（含 cdn.donmai.us）与 Wallhaven 在 Cloudflare 后面，
 * 浏览器 UA 会吃到 JS 挑战，必须声明非浏览器 UA（实测见 src/sources/shared.js）。
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
];

/**
 * 把一条路由定义转成中间件。
 * 图片走长缓存（同 Pixiv 缩略图策略，避免滚动时重复回源）。
 * @param {{prefix:string, target:string, kind:'api'|'img', userAgent?:string}} route
 * @returns {Function} Vite / Node 中间件
 */
export function createBooruMiddleware(route) {
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

/**
 * 非 Pixiv 图站代理 — 复用 proxy-utils 的通用中间件转发到 yande.re / konachan。
 *
 * Vite dev server 与 Electron 壳内代理服务共用这一份路由表，避免两边漂移。
 * ⚠️ 这里的路由必须与 src/sources/registry.js 的 net 配置保持一致
 *    （Node 侧不便直接 import src/ 下的 ESM，故保留一份等价定义）。
 *
 * 实测：图床本身没有防盗链，但 API 不返回 CORS 头，浏览器里必须走同源代理。
 */
import { createApiProxy, createImageProxy } from './proxy-utils.mjs';

/**
 * 路由表。prefix → 目标 host。
 * 图片路由的 Referer 设为目标域自身：这些图床不校验 Referer，白送站点页的假 Referer 反而奇怪。
 */
export const BOORU_ROUTES = [
  { prefix: '/yande-api', target: 'https://yande.re', kind: 'api' },
  { prefix: '/yande-img', target: 'https://files.yande.re', kind: 'img' },
  { prefix: '/yande-thumb', target: 'https://assets.yande.re', kind: 'img' },
  { prefix: '/konachan-api', target: 'https://konachan.com', kind: 'api' },
  { prefix: '/konachan-img', target: 'https://konachan.com', kind: 'img' },
];

/**
 * 把一条路由定义转成中间件。
 * 图片走长缓存（同 Pixiv 缩略图策略，避免滚动时重复回源）。
 * @param {{prefix:string, target:string, kind:'api'|'img'}} route
 * @returns {Function} Vite / Node 中间件
 */
export function createBooruMiddleware(route) {
  if (route.kind === 'img') {
    return createImageProxy(route.target, {
      referer: route.target,
      cacheControl: 'public, max-age=604800',
    });
  }
  return createApiProxy(route.target);
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

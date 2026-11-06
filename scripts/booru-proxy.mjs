/**
 * 非 Pixiv 图站代理 — 复用 proxy-utils 的通用中间件转发到各图站。
 *
 * Vite dev server 与 Electron 壳内代理服务共用这一份路由表，避免两边漂移。
 * 路由表 BOORU_ROUTES 直接从 src/sources/registry.js 的 net 配置派生
 * （Node 侧可直接 import src/，check-sources.mjs 已验证），改注册表即全局生效。
 *
 * 实测：图床本身没有防盗链，但多数站的 API 不返回 CORS 头，浏览器里必须走同源代理。
 */
import { createApiProxy, createImageProxy, createH2Proxy } from './proxy-utils.mjs';
import { SOURCES } from '../src/sources/registry.js';

/**
 * 路由表，从注册表 net 派生：prefix → 目标 host。
 * 图片路由的 Referer 设为目标域自身：这些图床不校验 Referer，白送站点页的假 Referer 反而奇怪。
 *
 * userAgent（来源级）：Danbooru 系（含 cdn.donmai.us）与 Wallhaven 在 Cloudflare 后面，
 * 浏览器 UA 会吃到 JS 挑战，必须声明非浏览器 UA（实测见 src/sources/shared.js）。
 *
 * http2（来源级）：hypnohub / xbooru 在应用层强制 HTTP/2 —— TLS 能握手，但
 * HTTP/1.1 请求一律挂起不响应（浏览器默认 h2 所以无感）。这类路由走 createH2Proxy。
 *
 * 同一图床域名可被多个来源认领（safebooru-donmai 复用 danbooru 的 cdn.donmai.us）：
 * check-sources.mjs 已断言同域名必同前缀，这里按前缀去重即可。
 */
export const BOORU_ROUTES = (() => {
  const routes = [];
  const seen = new Set();
  for (const source of Object.values(SOURCES)) {
    if (source.kind === 'pixiv') continue;
    const { apiPrefix, apiOrigin, imgHosts, userAgent, http2 } = source.net;
    if (!seen.has(apiPrefix)) {
      seen.add(apiPrefix);
      routes.push({ prefix: apiPrefix, target: apiOrigin, kind: 'api', userAgent, http2 });
    }
    for (const [host, prefix] of Object.entries(imgHosts || {})) {
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      routes.push({ prefix, target: `https://${host}`, kind: 'img', userAgent, http2 });
    }
  }
  return routes;
})();

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

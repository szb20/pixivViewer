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
    const { apiPrefix, apiOrigin, imgHosts, imgReferer, direct, userAgent, http2 } = source.net;
    if (!seen.has(apiPrefix)) {
      seen.add(apiPrefix);
      routes.push({ prefix: apiPrefix, target: apiOrigin, kind: 'api', userAgent, http2, direct });
    }
    for (const [host, prefix] of Object.entries(imgHosts || {})) {
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      routes.push({ prefix, target: `https://${host}`, kind: 'img', imgReferer, userAgent, http2, direct });
    }
  }
  // 微博访客系统（换 SUB Cookie 的 passport 域，见 sources/weibo.js）：
  // 不属于任何单站的 API/图床，手动登记一条（POST 表单由 createApiProxy 原样透传）。
  routes.push({ prefix: '/weibo-passport', target: 'https://visitor.passport.weibo.cn', kind: 'api', direct: true });
  return routes;
})();

/**
 * 把一条路由定义转成中间件。
 * 图片走长缓存（同 Pixiv 缩略图策略，避免滚动时重复回源）。
 * @param {{prefix:string, target:string, kind:'api'|'img', userAgent?:string, http2?:boolean}} route
 * @returns {Function} Vite / Node 中间件
 */
export function createBooruMiddleware(route) {
  // X (Twitter) 的实例池会轮换，目标 host 由请求头 x-nitter-host 指定（见 createNitterProxy）
  if (route.prefix === '/nitter-api') {
    return createNitterProxy(new URL(route.target).host);
  }
  // Instagram 的 GraphQL 必需头大部分由适配器发送（X-FB-Friendly-Name 等见
  // PASSTHROUGH_HEADERS），这里只注入浏览器禁设、脚本发不出来的三个；
  // 缺 X-FB-Friendly-Name 会吃到 403 "Page Not Found"（见 sources/instagram.js）
  if (route.prefix === '/ig-api') {
    return createApiProxy(route.target, {
      userAgent: route.userAgent,
      extraHeaders: {
        'Origin': 'https://www.instagram.com',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
  }
  // Instagram 图床的 host 动态（instagram.f*.fna.fbcdn.net 几十个区域分域）：
  // 适配器把 URL 改写成 /ig-img/<host>/<path>，host 由路径指定（见 createIgImgProxy）
  if (route.prefix === '/ig-img') {
    return createIgImgProxy();
  }
  // 强制 HTTP/2 的站点：走 CONNECT 隧道 + node:http2（见 proxy-utils.mjs 的 createH2Proxy）
  if (route.http2) {
    return createH2Proxy(route.target, {
      userAgent: route.userAgent,
      cacheControl: route.kind === 'img' ? 'public, max-age=604800' : undefined,
    });
  }
  if (route.kind === 'img') {
    return createImageProxy(route.target, {
      // imgReferer：sinaimg 这类校验 Referer 的图床必须发微博域（缺省同图床域自身）
      referer: route.imgReferer || route.target,
      cacheControl: 'public, max-age=604800',
      userAgent: route.userAgent,
      direct: route.direct,
    });
  }
  return createApiProxy(route.target, { userAgent: route.userAgent, direct: route.direct });
}

/**
 * Nitter 的动态代理：目标实例由请求头 `x-nitter-host` 指定。
 *
 * 为什么要动态：适配器会在实例池里轮换（某个实例 403/429 就换下一个），
 * 静态 target 跟不上轮换；而路由表仍从注册表派生（BOORU_ROUTES 里的
 * /nitter-api 只是「默认实例」，供 check-sources 校验一致性）。
 *
 * 安全：这是本地 dev / 桌面壳代理，仍然只放行「公网域名」形状的 host，
 * 拒绝 IP、端口、localhost、userinfo —— 别让它变成任意站点的跳板。
 *
 * @param {string} defaultHost — 无请求头时的兜底实例
 * @returns {Function} 中间件
 */
export function createNitterProxy(defaultHost) {
  const proxies = new Map();
  const hostRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  // Nitter 的反爬（Gandalf）只认真实浏览器 UA：默认的「AppleWebKit/537.36 开头、没有 Chrome 段」
  // 会被判成爬虫直接 403。Accept / Referer 也一并发成浏览器读 RSS 的样子。
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const proxyFor = (host) => {
    if (!proxies.has(host)) {
      proxies.set(host, createApiProxy(`https://${host}`, {
        userAgent: UA,
        extraHeaders: {
          'Accept': 'application/rss+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': `https://${host}/`,
        },
      }));
    }
    return proxies.get(host);
  };

  return (req, res) => {
    const header = String(req.headers['x-nitter-host'] || '').trim().toLowerCase();
    const host = header || defaultHost;
    if (!hostRe.test(host) || host.includes('..')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_nitter_host' }));
      return;
    }
    proxyFor(host)(req, res);
  };
}

/**
 * Instagram 图床的动态代理：目标 host 由路径首段指定（/ig-img/<host>/<path...>）。
 *
 * 为什么要动态：fbcdn 的图片域是区域分域（instagram.fhkg4-2.fna.fbcdn.net 等
 * 几十个，且会随 CDN 调度变化），枚举进注册表不现实；适配器直接把完整 host
 * 编进代理路径（见 sources/instagram.js 的 igImg）。
 *
 * 安全：本地代理不能变成任意站点跳板 —— host 白名单只放行 *.fbcdn.net 与
 * *.cdninstagram.com（Instagram 的官方 CDN 域），并做形状校验。
 *
 * @returns {Function} 中间件
 */
export function createIgImgProxy() {
  const proxies = new Map();
  const hostRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  const allow = (host) =>
    hostRe.test(host) && !host.includes('..')
    && (host.endsWith('.fbcdn.net') || host.endsWith('.cdninstagram.com'));

  const proxyFor = (host) => {
    if (!proxies.has(host)) {
      proxies.set(host, createImageProxy(`https://${host}`, {
        cacheControl: 'public, max-age=604800',
      }));
    }
    return proxies.get(host);
  };

  return (req, res) => {
    // Vite / Electron 已剥掉 /ig-img 前缀，req.url 形如 /<host>/<path...>
    const m = String(req.url || '').match(/^\/([^/]+)(\/.*)?$/);
    const host = (m?.[1] || '').toLowerCase();
    if (!allow(host)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_ig_img_host' }));
      return;
    }
    req.url = m?.[2] || '/';
    proxyFor(host)(req, res);
  };
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

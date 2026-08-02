/**
 * Pixiv 代理中间件 — 通过 Clash 代理转发请求到 Pixiv。
 * API/缩略图/ZIP 复用公共代理工具，图片需要重定向处理保留自定义逻辑。
 *
 * 从 scripts/pixiv-proxy.mjs 提取的 Pixiv 专用部分。
 */
import https from 'node:https';
import { getProxyUrl, createApiProxy, createImageProxy, createAgentHolder } from './proxy-utils.mjs';

/** 统一错误处理：记录日志 + 返回 502 */
function proxyError(req, res, err, context = '') {
  const msg = err?.message || String(err);
  const isRefused = msg.includes('ECONNREFUSED') || msg.includes('connect refused');
  if (isRefused) {
    console.error(`   ⚠️ [proxy] ${context}代理连接失败 — 请检查 Clash 代理是否运行中`);
    console.error(`      代理地址: ${getProxyUrl()}`);
  } else if (msg.includes('ETIMEOUT') || msg.includes('timeout')) {
    console.error(`   ⚠️ [proxy] ${context}代理请求超时`);
  } else {
    console.warn(`   ⚠️ [proxy] ${context}上游连接失败: ${msg}`);
  }
  if (!res.headersSent) res.writeHead(502).end();
}

/** /pixiv-img/*, /pixiv-thumb/*, /pixiv-zip/* → i.pixiv.re / pixiv.re */
export function pixivImageProxy() {
  const proxyUrl = getProxyUrl();
  const holder = createAgentHolder(proxyUrl);
  const imgHeaders = { Referer: 'https://www.pixiv.net/' };

  const doRequest = (url, headers, agent) => new Promise((ok, fail) => {
    const r = https.request(url, { headers, agent }, (p) => ok(p));
    r.on('error', fail);
    r.end();
  });

  /** 连接级失败时换全新 Agent 重试一次，吸收 Clash/Pixiv 的间歇性断连 */
  const withRetry = async (fn, context) => {
    try {
      return await fn(holder.get());
    } catch (err) {
      console.warn(`   ⚠️ [proxy] ${context} 上游连接失败: ${err.message || err}，正在重试...`);
      holder.reset();
      return await fn(holder.get());
    }
  };

  return {
    /** /pixiv-img/... → i.pixiv.re 或 pixiv.re（需处理重定向） */
    img: (req, res) => {
      const pathPart = req.url.slice(1);
      // c/ 前缀也走 i.pixiv.re（缩略图裁剪路径）
      const isFullPath = /^(img[-/]|c\/)/.test(pathPart);
      (async () => {
        try {
          if (isFullPath) {
            const p = await withRetry((agent) => doRequest(`https://i.pixiv.re/${pathPart}`, imgHeaders, agent), 'pixiv-img');
            // 图片可长缓存：滚动浏览网格/回看时浏览器直接命中缓存，避免重复下载
            res.writeHead(p.statusCode, { ...p.headers, 'Cache-Control': 'public, max-age=604800' });
            p.pipe(res);
          } else {
            const baseUrl = `https://pixiv.re/${pathPart}`;
            const doGet = (url, agent) => new Promise((ok, fail) => {
              https.get(url, { headers: imgHeaders, agent }, (r) => ok(r)).on('error', fail);
            });
            let r = await withRetry((agent) => doGet(baseUrl, agent), 'pixiv-img');
            if ([301, 302, 307, 308].includes(r.statusCode) && r.headers.location) {
              const redirect = new URL(r.headers.location, baseUrl).href;
              r = await withRetry((agent) => doGet(redirect, agent), 'pixiv-img-redirect');
            }
            res.writeHead(r.statusCode, { ...r.headers, 'Cache-Control': 'public, max-age=604800' });
            r.pipe(res);
          }
        } catch (err) {
          proxyError(req, res, err, isFullPath ? 'pixiv-img' : 'pixiv-img-redirect');
        }
      })();
    },

    /** /pixiv-thumb/... → i.pixiv.re */
    thumb: createImageProxy('https://i.pixiv.re', {
      referer: 'https://www.pixiv.net/',
      cacheControl: 'public, max-age=604800',
    }),

    /** /pixiv-zip/... → 原始 ZIP（Ugoira 动图） */
    zip: (req, res) => {
      const targetUrl = decodeURIComponent(req.url.slice(1));
      (async () => {
        try {
          const p = await withRetry(
            (agent) => doRequest(targetUrl, { Referer: 'https://www.pixiv.net/', 'User-Agent': 'Mozilla/5.0' }, agent),
            'pixiv-zip',
          );
          const headers = { ...p.headers, 'Access-Control-Allow-Origin': '*' };
          res.writeHead(p.statusCode, headers);
          p.pipe(res);
        } catch (err) {
          proxyError(req, res, err, 'pixiv-zip');
        }
      })();
    },
  };
}

/**
 * 注册 Pixiv 代理到 Vite dev server。
 */
export function registerPixivProxies(server) {
  const img = pixivImageProxy();
  server.middlewares.use('/pixiv-api', createApiProxy('https://www.pixiv.net'));
  server.middlewares.use('/pixiv-img', img.img);
  server.middlewares.use('/pixiv-thumb', img.thumb);
  server.middlewares.use('/pixiv-zip', img.zip);
}

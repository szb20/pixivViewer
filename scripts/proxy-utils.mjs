/**
 * Vite 代理工具 — 创建走 Clash 代理的 HTTPS 中间件。
 *
 * 所有需要翻墙的外部服务（Pixiv / yande / iwara）共用此模块。
 *
 * 用法：
 *   import { createApiProxy, createImageProxy } from '../scripts/proxy-utils.mjs';
 *   server.middlewares.use('/yande-api', createApiProxy('https://yande.re'));
 *   server.middlewares.use('/yande-img', createImageProxy('https://files.yande.re'));
 */

import http2 from 'node:http2';
import https from 'node:https';
import { Socket } from 'node:net';
import tls from 'node:tls';
import { HttpsProxyAgent } from 'https-proxy-agent';

const DEFAULT_PROXY = 'http://127.0.0.1:7890';

/**
 * 默认向源站声明的 UA。
 * ⚠️ 个别站点（Danbooru 系，及其 cdn）在 Cloudflare 后面，会拒掉
 *    「浏览器 UA + 非浏览器 TLS 指纹」的组合 → 403 JS 挑战。
 *    这类来源要在路由定义里显式给 userAgent（见 scripts/booru-proxy.mjs）。
 */
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** 获取代理 URL — 优先读环境变量，其次用默认值 */
export function getProxyUrl() {
  return process.env.VITE_PROXY_URL || process.env.PROXY_URL || DEFAULT_PROXY;
}

/** 创建一个 HTTPS 代理 Agent */
export function createAgent(proxyUrl) {
  return new HttpsProxyAgent(proxyUrl || getProxyUrl());
}

/**
 * 可重置的共享 Agent 容器。
 *
 * 长时间复用同一个 https-proxy-agent 时，Pixiv/Clash 可能关闭空闲隧道，
 * 复用到已失效的连接会导致间歇性 502。出错时调用 reset() 换成全新 Agent。
 */
export function createAgentHolder(proxyUrl) {
  let agent = createAgent(proxyUrl);
  return {
    get() {
      return agent;
    },
    reset() {
      try {
        agent.destroy();
      } catch {
        /* ignore */
      }
      agent = createAgent(proxyUrl);
      console.warn('[proxy] 代理连接池已重置，后续请求使用全新连接');
    },
  };
}

/**
 * 检查代理是否可用（通过尝试建立 TCP 连接）。
 * 在 Vite dev server 启动时调用，提前给用户提示。
 */
export function checkProxyAvailability() {
  const proxyUrl = getProxyUrl();
  const parsed = new URL(proxyUrl);
  const host = parsed.hostname;
  const port = parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80);

  const sock = new Socket();
  sock.setTimeout(2000);

  return new Promise((resolve) => {
    sock.on('connect', () => {
      sock.destroy();
      console.log(`   ✅ 代理可用: ${proxyUrl}`);
      resolve(true);
    });
    sock.on('error', () => {
      sock.destroy();
      console.warn(`   ⚠️  代理不可用: ${proxyUrl}`);
      console.warn('      部分功能（Pixiv / iwara / yande.re）将无法使用。');
      console.warn('      如需使用，请启动 Clash 或其他 HTTP 代理，或设置环境变量:');
      console.warn('      set PROXY_URL=http://127.0.0.1:7890');
      resolve(false);
    });
    sock.on('timeout', () => {
      sock.destroy();
      console.warn(`   ⚠️  代理连接超时: ${proxyUrl}`);
      resolve(false);
    });
    sock.connect(port, host);
  });
}

/**
 * 创建 API 代理中间件（转发到目标 host，走 Clash）。
 * @param {string} targetHost — 如 'https://www.pixiv.net'
 * @param {Object} [opts]
 * @param {Object} [opts.extraHeaders] — 额外的请求头
 * @param {string} [opts.userAgent] — 覆盖默认 UA
 * @returns {Function} Vite 中间件
 */
export function createApiProxy(targetHost, opts = {}) {
  const holder = createAgentHolder();
  const extraHeaders = opts.extraHeaders || {};
  const userAgent = opts.userAgent || DEFAULT_UA;

  return (req, res) => {
    // Vite 已剥离挂载前缀，req.url 是剩余路径
    let parsed;
    try {
      parsed = new URL(`${targetHost}${req.url}`);
    } catch {
      // 畸形 URL 不能抛进调用方（dev 中间件 / Electron 主进程）
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_target' }));
      return;
    }

    const send = (agent) => new Promise((resolve, reject) => {
      const proxyOpts = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: {
          'User-Agent': userAgent,
          'Accept': 'application/json, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Referer': targetHost,
          ...extraHeaders,
          // 透传业务头：关注/取消关注是 POST 表单，缺 Content-Type 与 x-csrf-token
          // 会被 Pixiv 直接拒绝（dev / 桌面端点赞关注失败的原因）
          ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
          ...(req.headers['x-csrf-token'] ? { 'x-csrf-token': req.headers['x-csrf-token'] } : {}),
          // 透传自定义头
          ...(req.headers['x-pixiv-cookie'] ? { Cookie: req.headers['x-pixiv-cookie'] } : {}),
        },
        agent,
        timeout: 15000,
      };
      delete proxyOpts.headers['host'];

      const proxyReq = https.request(proxyOpts, (proxyRes) => {
        // 响应已开始后出错（半截流）无法重试：直接掐断客户端连接
        if (res.headersSent) {
          proxyRes.resume();
          resolve();
          return;
        }
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        resolve();
      });

      proxyReq.on('error', (err) => {
        if (res.headersSent) {
          res.destroy();
          resolve();
          return;
        }
        reject(err);
      });
      proxyReq.on('timeout', () => {
        proxyReq.destroy(new Error('ETIMEDOUT'));
      });

      if (req.method === 'POST' || req.method === 'PUT') {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    });

    // 只有幂等请求才自动重试：POST/PUT 的 body 已被 req.pipe 消费掉，
    // 重发会变成空 body（且可能重复副作用），直接报错让客户端决定
    const retryable = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';

    (async () => {
      try {
        await send(holder.get());
      } catch (err) {
        const msg0 = err.message || String(err);
        if (!retryable) {
          console.warn(`[proxy] ${targetHost} ${req.method} 上游连接失败: ${msg0}`);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: msg0 }));
          }
          return;
        }
        // 连接级失败：记录真实错误、换新连接、重试一次
        console.warn(`[proxy] ${targetHost} 上游连接失败: ${msg0}，正在重试...`);
        holder.reset();
        try {
          await send(holder.get());
        } catch (err2) {
          const msg = err2.message || String(err2);
          console.error(`[proxy] ${targetHost} 重试仍失败: ${msg}`);
          if (!res.headersSent) {
            const isTimeout = /timeout|ETIMEDOUT/i.test(msg);
            res.writeHead(isTimeout ? 504 : 502);
            res.end(JSON.stringify({ error: msg }));
          }
        }
      }
    })();
  };
}

/**
 * 创建图片/文件代理中间件（GET 请求，带 Referer）。
 * @param {string} targetHost — 如 'https://files.yande.re'
 * @param {Object} [opts]
 * @param {string} [opts.referer] — Referer 头（默认同 targetHost）
 * @param {number} [opts.timeout=30000] — 超时毫秒（图片可能较大）
 * @param {string} [opts.cacheControl] — 响应 Cache-Control 头（例如 'public, max-age=604800'），缺省透传上游
 * @param {string} [opts.userAgent] — 覆盖默认 UA（图床在 Cloudflare 后面时需要，见 DEFAULT_UA）
 * @returns {Function} Vite 中间件
 */
export function createImageProxy(targetHost, opts = {}) {
  const holder = createAgentHolder();
  const referer = opts.referer || targetHost;
  const timeout = opts.timeout || 30000;
  const cacheControl = opts.cacheControl || null;
  const userAgent = opts.userAgent || DEFAULT_UA;

  return (req, res) => {
    let parsed;
    try {
      parsed = new URL(`${targetHost}${req.url}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_target' }));
      return;
    }

    const send = (agent) => new Promise((resolve, reject) => {
      const proxyOpts = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          'Referer': referer,
          'Accept': '*/*',
        },
        agent,
        timeout,
      };

      const proxyReq = https.request(proxyOpts, (proxyRes) => {
        if (res.headersSent) {
          proxyRes.resume();
          resolve();
          return;
        }
        const headers = cacheControl
          ? { ...proxyRes.headers, 'Cache-Control': cacheControl }
          : proxyRes.headers;
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
        resolve();
      });

      proxyReq.on('error', (err) => {
        if (res.headersSent) {
          res.destroy();
          resolve();
          return;
        }
        reject(err);
      });
      proxyReq.on('timeout', () => {
        proxyReq.destroy(new Error('ETIMEDOUT'));
      });
      proxyReq.end();
    });

    (async () => {
      try {
        await send(holder.get());
      } catch (err) {
        console.warn(`[proxy] ${targetHost} 上游连接失败: ${err.message || err}，正在重试...`);
        holder.reset();
        try {
          await send(holder.get());
        } catch (err2) {
          const msg = err2.message || String(err2);
          console.error(`[proxy] ${targetHost} 重试仍失败: ${msg}`);
          if (!res.headersSent) {
            res.writeHead(/timeout|ETIMEDOUT/i.test(msg) ? 504 : 502).end();
          }
        }
      }
    })();
  };
}

/**
 * 经 Clash 建立到目标站的 CONNECT 隧道，返回裸 TCP socket。
 * （https-proxy-agent 只支持 HTTP/1.1，强制 HTTP/2 的站点握手后对 1.1 请求不响应，
 *  需要手动建隧道再套 node:http2 —— 实测见 hypnohub/xbooru）
 * @param {string} host — 目标站域名
 * @returns {Promise<Socket>}
 */
function connectTunnel(host) {
  const proxyUrl = getProxyUrl();
  const parsed = new URL(proxyUrl);
  const proxyHost = parsed.hostname;
  const proxyPort = parseInt(parsed.port, 10) || 7890;
  return new Promise((resolve, reject) => {
    const s = new Socket();
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error('CONNECT 隧道超时'));
    }, 10000);
    s.once('connect', () => {
      s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    s.once('data', (d) => {
      const head = d.toString().split('\r\n')[0];
      clearTimeout(timer);
      if (/ 200 /.test(` ${head} `)) resolve(s);
      else {
        s.destroy();
        reject(new Error(`CONNECT 失败: ${head}`));
      }
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    s.connect(proxyPort, proxyHost);
  });
}

/**
 * 创建 HTTP/2 代理中间件 —— 给「应用层强制 HTTP/2」的站点用（hypnohub / xbooru）。
 *
 * 与 createApiProxy 的差异：不走 https-proxy-agent（HTTP/1.1），
 * 而是 CONNECT 隧道 + tls(ALPN=h2) + node:http2 会话，逐请求转发。
 * 会话不跨请求复用（隧道生命周期短，重开成本低，也避免半死连接）。
 *
 * @param {string} targetHost — 如 'https://hypnohub.net'
 * @param {Object} [opts]
 * @param {string} [opts.userAgent] — 覆盖默认 UA
 * @param {string} [opts.referer]   — Referer 头（缺省同 targetHost，图床路由用）
 * @param {string} [opts.cacheControl] — 覆盖响应 Cache-Control（图片长缓存）
 * @param {number} [opts.timeout=15000] — 超时毫秒
 * @returns {Function} Vite / Node 中间件
 */
export function createH2Proxy(targetHost, opts = {}) {
  const userAgent = opts.userAgent || DEFAULT_UA;
  const referer = opts.referer || targetHost;
  const cacheControl = opts.cacheControl || null;
  const timeout = opts.timeout || 15000;

  return (req, res) => {
    let parsed;
    try {
      parsed = new URL(`${targetHost}${req.url}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_target' }));
      return;
    }

    const send = () => new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      connectTunnel(parsed.hostname)
        .then((sock) => {
          const client = http2.connect(`https://${parsed.hostname}`, {
            createConnection: () => tls.connect({
              socket: sock,
              servername: parsed.hostname,
              ALPNProtocols: ['h2'],
            }),
          });
          const cleanup = () => {
            try { client.destroy(); } catch { /* ignore */ }
            try { sock.destroy(); } catch { /* ignore */ }
          };
          client.once('error', (e) => { cleanup(); fail(e); });

          client.once('connect', () => {
            const h2req = client.request({
              ':method': req.method,
              ':path': parsed.pathname + parsed.search,
              'user-agent': userAgent,
              'accept': 'application/json, */*',
              'referer': referer,
            });
            const timer = setTimeout(() => {
              try { h2req.close(); } catch { /* ignore */ }
              cleanup();
              fail(new Error('ETIMEDOUT'));
            }, timeout);

            h2req.on('response', (headers) => {
              if (res.headersSent) {
                cleanup();
                ok();
                return;
              }
              const status = headers[':status'] || 502;
              const out = {};
              for (const [k, v] of Object.entries(headers)) {
                if (k.startsWith(':')) continue;
                out[k] = v;
              }
              if (cacheControl) out['Cache-Control'] = cacheControl;
              res.writeHead(status, out);
              h2req.pipe(res);
              h2req.on('end', () => { clearTimeout(timer); cleanup(); ok(); });
              h2req.on('error', () => {
                clearTimeout(timer);
                cleanup();
                // 响应已开始后出错（半截流）无法重试：直接掐断客户端连接
                res.destroy();
                ok();
              });
            });
            h2req.once('error', (e) => { clearTimeout(timer); cleanup(); fail(e); });
            h2req.end();
          });
        })
        .catch((e) => fail(e));
    });

    (async () => {
      try {
        await send();
      } catch (err) {
        const msg0 = err.message || String(err);
        console.warn(`[proxy-h2] ${targetHost} 请求失败: ${msg0}，正在重试...`);
        try {
          await send();
        } catch (err2) {
          const msg = err2.message || String(err2);
          console.error(`[proxy-h2] ${targetHost} 重试仍失败: ${msg}`);
          if (!res.headersSent) {
            res.writeHead(/timeout|ETIMEDOUT/i.test(msg) ? 504 : 502).end();
          }
        }
      }
    })();
  };
}

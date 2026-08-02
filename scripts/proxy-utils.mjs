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

import https from 'node:https';
import http from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Socket } from 'node:net';

const DEFAULT_PROXY = 'http://127.0.0.1:7890';

/** 获取代理 URL — 优先读环境变量，其次用默认值 */
export function getProxyUrl() {
  return process.env.VITE_PROXY_URL || process.env.PROXY_URL || DEFAULT_PROXY;
}

/** 创建一个 HTTPS 代理 Agent */
export function createAgent(proxyUrl) {
  return new HttpsProxyAgent(proxyUrl || getProxyUrl());
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
 * @returns {Function} Vite 中间件
 */
export function createApiProxy(targetHost, opts = {}) {
  const agent = createAgent();
  const extraHeaders = opts.extraHeaders || {};

  return (req, res) => {
    // Vite 已剥离挂载前缀，req.url 是剩余路径
    const targetUrl = `${targetHost}${req.url}`;
    const parsed = new URL(targetUrl);

    const proxyOpts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': targetHost,
        ...extraHeaders,
        // 透传自定义头
        ...(req.headers['x-pixiv-cookie'] ? { Cookie: req.headers['x-pixiv-cookie'] } : {}),
      },
      agent,
      timeout: 15000,
    };

    delete proxyOpts.headers['host'];

    const proxyReq = https.request(proxyOpts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      const msg = err?.message || '';
      if (msg.includes('ECONNREFUSED') || msg.includes('connect refused')) {
        console.log(`   ⚠️ [proxy] ${targetHost} 代理连接失败 — Clash 可能未运行`);
      }
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end(JSON.stringify({ error: 'timeout' }));
      }
    });

    if (req.method === 'POST' || req.method === 'PUT') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  };
}

/**
 * 创建图片/文件代理中间件（GET 请求，带 Referer）。
 * @param {string} targetHost — 如 'https://files.yande.re'
 * @param {Object} [opts]
 * @param {string} [opts.referer] — Referer 头（默认同 targetHost）
 * @param {number} [opts.timeout=30000] — 超时毫秒（图片可能较大）
 * @param {string} [opts.cacheControl] — 响应 Cache-Control 头（例如 'public, max-age=604800'），缺省透传上游
 * @returns {Function} Vite 中间件
 */
export function createImageProxy(targetHost, opts = {}) {
  const agent = createAgent();
  const referer = opts.referer || targetHost;
  const timeout = opts.timeout || 30000;
  const cacheControl = opts.cacheControl || null;

  return (req, res) => {
    const targetUrl = `${targetHost}${req.url}`;
    const parsed = new URL(targetUrl);

    const proxyOpts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': referer,
        'Accept': '*/*',
      },
      agent,
      timeout,
    };

    const proxyReq = https.request(proxyOpts, (proxyRes) => {
      const headers = cacheControl
        ? { ...proxyRes.headers, 'Cache-Control': cacheControl }
        : proxyRes.headers;
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      const msg = err?.message || '';
      if (msg.includes('ECONNREFUSED') || msg.includes('connect refused')) {
        console.log(`   ⚠️ [proxy] ${targetHost} 代理连接失败 — Clash 可能未运行`);
      }
      if (!res.headersSent) res.writeHead(502).end();
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) res.writeHead(504).end();
    });

    proxyReq.end();
  };
}

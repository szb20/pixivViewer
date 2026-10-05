/**
 * PixivViewer 桌面壳 — Electron 主进程。
 *
 * 职责：
 * 1. 内嵌 Pixiv 代理服务（复用 scripts/pixiv-proxy.mjs 的 4 条中间件），
 *    供 renderer 以 http://127.0.0.1:<port>/pixiv-api 等访问（绕开 CORS + Cookie 限制）。
 * 2. 创建 BrowserWindow 加载生产构建 dist/（或 dev server）。
 * 3. IPC：proxy:get-port（renderer 构建 API 基址）、dialog:save-file（保存到磁盘）。
 */
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

let proxyUtils = null;
let pixivProxy = null;
let booruProxy = null;

const DEFAULT_PROXY_PORT = 51380;
const isDevServer = !!process.env.PIXIVVIEWER_DEV_URL;

let proxyServer = null;
let proxyPort = 0;
let mainWindow = null;

/** 统一 CORS 头（每次调用固定为这份值） */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

/**
 * 包装 res：上游中间件用 res.writeHead(status, upstreamHeaders) 会整体替换已有头，
 * 导致这里预设的 CORS 头被冲掉。这里把 writeHead 换成"始终合并 CORS 头"的版本。
 * （renderer 以 file:// 加载，跨源 fetch 必须见到 Access-Control-Allow-Origin）
 */
function withCors(res) {
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (statusCode, statusMessage, headers) => {
    // 兼容 (status, headers) 两参调用
    if (typeof statusMessage === 'object' && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = undefined;
    }
    const merged = { ...CORS_HEADERS };
    if (headers && typeof headers === 'object') Object.assign(merged, headers);
    return origWriteHead(statusCode, statusMessage, merged);
  };
  return res;
}

/** 处理 OPTIONS 预检（file:// 页面发起跨源 fetch 前会先发 preflight） */
function optionsMiddleware(req, res, next) {
  if (req.method === 'OPTIONS') {
    withCors(res).writeHead(204).end();
    return;
  }
  next();
}

/** 启动内嵌代理服务（复用 Vite dev 的同款中间件） */
async function startProxyServer() {
  const basePort = Number(process.env.PIXIVVIEWER_PROXY_PORT) || DEFAULT_PROXY_PORT;

  // scripts/*.mjs 是 ESM，主进程（CJS）里动态 import
  proxyUtils = await import('../scripts/proxy-utils.mjs');
  pixivProxy = await import('../scripts/pixiv-proxy.mjs');
  booruProxy = await import('../scripts/booru-proxy.mjs');
  const { createApiProxy } = proxyUtils;

  // 复用 scripts/ 下的现有中间件（与 Vite dev 完全同款），仅新增 CORS 包装：
  // /pixiv-api → www.pixiv.net（透传 x-pixiv-cookie 头）
  // /pixiv-img | /pixiv-thumb → i.pixiv.re
  // /pixiv-zip → 原始 ZIP（Ugoira）
  // /yande-* / /konachan-* → 见 scripts/booru-proxy.mjs 的路由表
  const img = pixivProxy.pixivImageProxy();
  const routes = [
    { prefix: '/pixiv-api', fn: createApiProxy('https://www.pixiv.net') },
    { prefix: '/pixiv-img', fn: img.img },
    { prefix: '/pixiv-thumb', fn: img.thumb },
    { prefix: '/pixiv-zip', fn: img.zip },
  ];
  for (const r of booruProxy.BOORU_ROUTES) {
    routes.push({ prefix: r.prefix, fn: booruProxy.createBooruMiddleware(r) });
  }
  // 长前缀优先：/yande-img 与 /yande-thumb 不互为前缀，但保持通用规则以防后续加站点
  routes.sort((a, b) => b.prefix.length - a.prefix.length);

  const server = http.createServer((req, res) => {
    optionsMiddleware(req, res, () => {
      const route = routes.find(r => req.url.startsWith(r.prefix));
      if (!route) {
        withCors(res).writeHead(404).end();
        return;
      }
      // 剥掉前缀交给中间件（与 Vite 剥前缀的语义一致）
      req.url = req.url.slice(route.prefix.length) || '/';
      withCors(res);
      // 中间件抛错（如畸形 URL / 非法百分号编码）绝不能冒泡到主进程：
      // 未捕获异常会让 Electron 弹错误框甚至中断进程，这里统一兜底 500。
      const onRouteError = (e) => {
        console.warn('[desktop] 代理路由异常:', e?.message || e);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy_route_failed' }));
      };
      try {
        const ret = route.fn(req, res);
        if (ret && typeof ret.catch === 'function') ret.catch(onRouteError);
      } catch (e) {
        onRouteError(e);
      }
    });
  });

  // 端口被占用时依次 +1 重试（多实例并存场景）
  let lastErr = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const candidate = basePort + attempt;
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => {
          server.removeListener('error', reject);
          proxyPort = candidate;
          resolve();
        });
      });
      break;
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  if (!proxyPort) throw lastErr || new Error('代理端口分配失败');
  proxyServer = server;
  console.log(`[desktop] 代理服务已启动: http://127.0.0.1:${proxyPort}（${routes.length} 条路由）`);
}

/**
 * 桌面流式下载通道 —— 主进程用 Node HTTPS 拉图（走 Clash 代理），
 * 边下边把 { id, progress, loaded, total } 推给渲染进程，最后回 base64。
 * 与安卓 StreamingDownload 插件对等：给下载管理提供真实字节进度。
 * 渲染进程侧见 src/utils/desktopDownload.js。
 */
function registerDownloadIpc() {
  ipcMain.handle('download:image', async (event, { id, url, referer } = {}) => {
    if (!id || !url) throw new Error('bad_request');
    const holder = proxyUtils.createAgentHolder();
    const sender = event.sender;

    const once = (agent) => new Promise((resolve, reject) => {
      const req = https.request(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'image/*,*/*',
          ...(referer ? { Referer: referer } : {}),
        },
        agent,
      }, (res) => {
        if (res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers['content-length']) || 0;
        let loaded = 0;
        let lastAt = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          chunks.push(chunk);
          loaded += chunk.length;
          const now = Date.now();
          if (now - lastAt < 80 && (!total || loaded < total)) return;
          lastAt = now;
          // 下载期间窗口可能已关闭，发之前确认
          if (!sender.isDestroyed()) {
            sender.send('download:progress', {
              id,
              loaded,
              total,
              // 上游没给 Content-Length（total=0）时算不出百分比，给 null 由 UI 兜底
              progress: total ? Math.min(100, Math.round((loaded * 100) / total)) : null,
            });
          }
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });

    let buf;
    try {
      buf = await once(holder.get());
    } catch {
      // 连接级失败（Clash 间歇性断流）换全新 Agent 重试一次，与图片代理同策略
      holder.reset();
      buf = await once(holder.get());
    }
    return { id, size: buf.length, data: buf.toString('base64') };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 420,
    minHeight: 600,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 加载诊断：白屏/加载失败/渲染进程报错都在主进程终端打出，便于排查
  // 签名兼容：Electron ≤34 是 (event, level, message, line, sourceId)，≥35 改为单个 details 对象。
  // 必须按实参个数区分：旧式的第一个参数也是 Event 对象，只判断 typeof === 'object' 会
  // 永远走新式分支，把所有 renderer 日志读成 "[renderer:undefined] undefined"（等于没有日志）。
  const CONSOLE_LEVELS = ['verbose', 'info', 'warning', 'error'];
  mainWindow.webContents.on('console-message', (...args) => {
    const d = (args.length === 1 && args[0] && typeof args[0] === 'object' && 'message' in args[0])
      ? args[0]
      : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
    // 旧式 level 是数字（0-3），新式是字符串
    const level = typeof d.level === 'number' ? (CONSOLE_LEVELS[d.level] ?? d.level) : d.level;
    const where = d.sourceId ? ` (${d.sourceId}:${d.lineNumber})` : '';
    console.log(`[renderer:${level}] ${d.message}${where}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[desktop] 页面加载完成');
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.warn(`[desktop] 页面加载失败: ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.warn('[desktop] preload 加载失败:', preloadPath, error?.message || error);
  });

  if (isDevServer) {
    mainWindow.loadURL(process.env.PIXIVVIEWER_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  // 兜底：仅为 i.pximg.net 直连请求补 pixiv Referer（正常情况下代理已改写为 i.pixiv.re，无需 Referer）
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (/^https:\/\/i\.pximg\.net\//i.test(details.url)) {
      headers['Referer'] = 'https://www.pixiv.net/';
    }
    callback({ requestHeaders: headers });
  });

  // Danbooru 的图床在 Cloudflare 后面，而 Electron 渲染进程的直连会被它挡掉：
  // 换 UA（onBeforeSendHeaders）实测无效 —— 判定依据是 TLS/HTTP2 指纹，不是 UA。
  // 所以这里把图床请求整个改道到壳内代理：代理走 Node 的 TLS 通道 + 非浏览器 UA，
  // 实测 200（见 scripts/booru-proxy.mjs 的 userAgent 说明）。
  // 只改道这一个域：yande / konachan 的图床没有 Cloudflare，直连一直正常，不必冒代理挂掉的风险。
  const DANBOORU_IMG_HOST = 'cdn.donmai.us';
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*.donmai.us/*'] }, (details, callback) => {
    let target = null;
    try {
      target = new URL(details.url);
    } catch {
      callback({});
      return;
    }
    if (target.hostname !== DANBOORU_IMG_HOST || !proxyPort) {
      callback({});
      return;
    }
    callback({ redirectURL: `http://127.0.0.1:${proxyPort}/danbooru-img${target.pathname}${target.search}` });
  });

  ipcMain.handle('proxy:get-port', () => proxyPort);

/**
 * 给同名文件找一个不冲突的路径：`图.jpg` → `图 (2).jpg` → `图 (3).jpg` …
 * 直接覆盖会无声吞掉用户已有的文件；自动改名是下载器的常规做法。
 */
function uniquePath(dir, baseName) {
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let candidate = path.join(dir, baseName);
  for (let i = 2; fs.existsSync(candidate) && i < 1000; i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

/** 保存文件到磁盘。ask=false 且配置了目录时直接写入，不弹对话框 */
ipcMain.handle('dialog:save-file', async (_event, { data, fileName, mimeType, directory, ask = true } = {}) => {
  try {
    if (!data) return false;
    const baseName = String(fileName || 'pixiv_untitled.jpg').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
    const dir = typeof directory === 'string' && directory ? directory : '';
    const buf = Buffer.from(data, 'base64');

    // 用户已在设置里指定目录且关掉了「每次询问」→ 直接落盘
    if (dir && ask === false) {
      await fs.promises.mkdir(dir, { recursive: true });
      const filePath = uniquePath(dir, baseName);
      await fs.promises.writeFile(filePath, buf);
      console.log('[desktop] 已保存:', filePath);
      return true;
    }

    // 其余情况弹系统保存框；配置了目录就以它为起点
    const startDir = dir || app.getPath('pictures');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(startDir, baseName),
      filters: [{ name: mimeType || 'Image', extensions: [baseName.split('.').pop() || 'jpg'] }],
    });
    if (canceled || !filePath) return false;
    await fs.promises.writeFile(filePath, buf);
    return true;
  } catch (e) {
    console.warn('[desktop] 保存文件失败:', e?.message || e);
    return false;
  }
});

  ipcMain.handle('dialog:choose-directory', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: '选择图片保存目录',
        defaultPath: app.getPath('pictures'),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (canceled || !filePaths?.length) return null;
      return filePaths[0];
    } catch (e) {
      console.warn('[desktop] 选择目录失败:', e?.message || e);
      return null;
    }
  });

  await startProxyServer();
  registerDownloadIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (proxyServer) {
    try { proxyServer.close(); } catch { /* ignore */ }
    proxyServer = null;
  }
});
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
const fs = require('node:fs');
const path = require('node:path');

let proxyUtils = null;
let pixivProxy = null;

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
  const { createApiProxy } = proxyUtils;

  // 复用 scripts/ 下的现有中间件（与 Vite dev 完全同款），仅新增 CORS 包装：
  // /pixiv-api → www.pixiv.net（透传 x-pixiv-cookie 头）
  // /pixiv-img | /pixiv-thumb → i.pixiv.re
  // /pixiv-zip → 原始 ZIP（Ugoira）
  const img = pixivProxy.pixivImageProxy();
  const routes = [
    { prefix: '/pixiv-api', fn: createApiProxy('https://www.pixiv.net') },
    { prefix: '/pixiv-img', fn: img.img },
    { prefix: '/pixiv-thumb', fn: img.thumb },
    { prefix: '/pixiv-zip', fn: img.zip },
  ];

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
      route.fn(req, res);
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
  console.log(`[desktop] Pixiv 代理服务已启动: http://127.0.0.1:${proxyPort}`);
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
  mainWindow.webContents.on('console-message', (eventOrLevel, maybeMessage) => {
    // Electron 33 兼容：新式 event 对象 / 旧式 (level, message)
    const level = typeof eventOrLevel === 'object' ? eventOrLevel.level : eventOrLevel;
    const msg = typeof eventOrLevel === 'object' ? eventOrLevel.message : maybeMessage;
    console.log(`[renderer:${level}]`, msg);
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
    mainWindow.webContents.openDevTools({ mode: 'detach' });
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

  ipcMain.handle('proxy:get-port', () => proxyPort);

  ipcMain.handle('dialog:save-file', async (_event, { data, fileName, mimeType, directory } = {}) => {
    try {
      if (!data) return false;
      const baseName = String(fileName || 'pixiv_untitled.jpg').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
      // 保存目录优先取用户设置，未设置时默认系统图片文件夹
      const dir = typeof directory === 'string' && directory ? directory : app.getPath('pictures');
      const defaultPath = path.join(dir, baseName);
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath,
        filters: [{ name: mimeType || 'Image', extensions: [baseName.split('.').pop() || 'jpg'] }],
      });
      if (canceled || !filePath) return false;
      const buf = Buffer.from(data, 'base64');
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
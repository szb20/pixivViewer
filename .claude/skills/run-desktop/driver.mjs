#!/usr/bin/env node
/**
 * PixivViewer 桌面端（Electron）驱动 —— 启动应用、用 CDP 驱动 UI、抓日志与截图。
 *
 * 不依赖 Playwright：Electron 自带 `--remote-debugging-port`，Node 18+ 自带 WebSocket，
 * 两者拼起来就够用了（本机没有 playwright/puppeteer，也无需为此装依赖）。
 *
 * 用法：
 *   node .claude/skills/run-desktop/driver.mjs smoke
 *   node .claude/skills/run-desktop/driver.mjs report
 *   node .claude/skills/run-desktop/driver.mjs eval "document.title"
 *   node .claude/skills/run-desktop/driver.mjs shot 我的截图
 *
 * 选项：
 *   --dev         加载 vite dev server（需先另开 `npm run dev`），默认加载 dist/ 生产构建
 *   --port <n>    CDP 调试端口，默认 9222
 *   --out <dir>   截图目录，默认 log/desktop-shots
 *   --timeout <ms> 等待渲染进程出现的超时，默认 30000
 *
 * 退出码：0 正常；1 出现 console error / HTTP 4xx-5xx / 启动失败。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');

// ── 参数解析 ───────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { dev: false, port: 9222, out: 'log/desktop-shots', timeout: 30000, size: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dev') opts.dev = true;
  else if (a === '--port') opts.port = Number(argv[++i]);
  else if (a === '--out') opts.out = argv[++i];
  else if (a === '--timeout') opts.timeout = Number(argv[++i]);
  else if (a === '--size') { const [w, h] = argv[++i].split('x').map(Number); opts.size = { width: w, height: h }; }
  else positional.push(a);
}
const scenario = positional[0] || 'smoke';
const scenarioArg = positional.slice(1).join(' ');

const SHOT_DIR = path.isAbsolute(opts.out) ? opts.out : path.join(ROOT, opts.out);
/** 单条 CDP 命令的超时（毫秒）：渲染进程卡死时避免整轮僵在这里 */
const CDP_TIMEOUT_MS = 45000;
fs.mkdirSync(SHOT_DIR, { recursive: true });

const t0 = Date.now();
const lines = [];
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
function say(...a) { const s = `${stamp()} ${a.join(' ')}`; lines.push(s); console.log(s); }

// ── 启动 Electron ──────────────────────────────────────────
// 坑：某些环境（含本机 Claude Code 的 shell）预设 ELECTRON_RUN_AS_NODE=1，
// 会让 electron.exe 退化成普通 node，直接报 `bad option: --remote-debugging-port`。
// 必须先删掉它，否则 --dev / --port 一律不生效。
const spawnEnv = { ...process.env };
delete spawnEnv.ELECTRON_RUN_AS_NODE;
if (opts.dev) spawnEnv.PIXIVVIEWER_DEV_URL = `http://localhost:${process.env.VITE_PORT || 5182}`;

const electronBin = path.join(
  ROOT,
  process.platform === 'win32'
    ? 'node_modules/electron/dist/electron.exe'
    : process.platform === 'darwin'
      ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
      : 'node_modules/electron/dist/electron',
);

if (!opts.dev && !fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
  console.error(`缺少 ${path.join(ROOT, 'dist/index.html')} —— 先跑 npm run build，或加 --dev。`);
  process.exit(1);
}

const child = spawn(electronBin, [`--remote-debugging-port=${opts.port}`, '.'], {
  cwd: ROOT, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => { const s = `${stamp()} [main] ${d}`; lines.push(s); process.stdout.write(s); });
child.stderr.on('data', d => {
  const text = String(d);
  // Chromium 的 GPU/ANGLE 噪音，与本应用无关
  if (/DevTools listening|gpu_|ANGLE|dxdiag|Vulkan/i.test(text)) return;
  const s = `${stamp()} [main:err] ${text}`; lines.push(s); process.stdout.write(s);
});
child.on('exit', c => say(`electron 退出 code=${c}`));

/** Windows 上 child.kill 会留下 GPU/renderer 子进程，按进程树强杀 */
function killTree() {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch { /* ignore */ }
}

// ── CDP ────────────────────────────────────────────────────
async function waitTarget(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${opts.port}/json/list`)).json();
      const hit = list.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (hit && hit.url !== 'about:blank') return hit;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`等待渲染进程超时（${timeoutMs}ms）—— dist/ 是不是没构建？或端口 ${opts.port} 被占？`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map(); const listeners = new Set();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      } else if (m.method) for (const l of listeners) l(m);
    });
    ws.addEventListener('error', e => reject(new Error(`CDP 连接失败: ${e.message || e}`)));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          // 渲染进程卡住时 CDP 可能永不回包（截图尤其容易），加超时避免整轮僵死
          const timer = setTimeout(() => {
            pending.delete(mid);
            rej(new Error(`CDP ${method} 超时（${CDP_TIMEOUT_MS}ms）—— 渲染进程可能卡住了`));
          }, CDP_TIMEOUT_MS);
          pending.set(mid, {
            resolve: (v) => { clearTimeout(timer); res(v); },
            reject: (e) => { clearTimeout(timer); rej(e); },
          });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      on(fn) { listeners.add(fn); },
      close() { try { ws.close(); } catch { /* ignore */ } },
    }));
  });
}

const consoleErrors = [];   // renderer console.error / 未捕获异常
const consoleWarns = [];
const badStatus = [];       // HTTP 4xx / 5xx
const netFailed = [];

async function boot() {
  say(`启动 Electron（${opts.dev ? 'dev server' : 'dist/ 生产构建'}），CDP :${opts.port}`);
  const target = await waitTarget(opts.timeout);
  say(`渲染进程就绪: ${target.url}`);

  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  if (opts.size) {
    // 只在渲染进程层面改视口：媒体查询 / 布局随之变化，但 Electron 窗口本身不变
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.size.width, height: opts.size.height, deviceScaleFactor: 1, mobile: false,
    });
    say(`视口固定为 ${opts.size.width}x${opts.size.height}`);
  }

  cdp.on(m => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const { type, args } = m.params;
      const text = args.map(a => a.value ?? a.description ?? a.type).join(' ');
      if (type === 'error') consoleErrors.push(text);
      else if (type === 'warning') consoleWarns.push(text);
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
    } else if (m.method === 'Network.responseReceived') {
      const { status, url, mimeType } = m.params.response;
      if (status >= 400) badStatus.push(`${status} ${mimeType} ${url}`);
    } else if (m.method === 'Network.loadingFailed' && !m.params.canceled) {
      netFailed.push(`${m.params.errorText} ${m.params.type}`);
    }
  });
  return cdp;
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return `EVAL_ERROR: ${r.exceptionDetails.exception?.description}`;
  return r.result.value;
}

async function shot(cdp, name) {
  // 截图是诊断信息不是断言：渲染进程被遮挡 / 合成器停摆时会挂住，
  // 这里重试一次后跳过，别让整轮跑挂在一张图上。
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await cdp.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
      });
      const f = path.join(SHOT_DIR, `${name}.png`);
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      say(`截图 -> ${f}`);
      return f;
    } catch (e) {
      if (attempt === 2) {
        say(`⚠️ 截图失败，跳过 ${name}：${e.message}`);
        return null;
      }
      await sleep(1200);
    }
  }
  return null;
}

/** 按可见文本点击按钮/链接（用 DOM click，避免坐标命中错的层） */
async function clickText(cdp, text) {
  return evaluate(cdp, `(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"]')];
    const el = els.find(e => e.textContent?.trim() === ${JSON.stringify(text)})
            ?? els.find(e => e.textContent?.trim().includes(${JSON.stringify(text)}));
    if (!el) return 'NOT_FOUND';
    el.click(); return 'OK';
  })()`);
}

/** 搜索框几何 / 形态探针（手机贴顶浮动 vs 桌面内容区悬浮胶囊） */
async function probeSearchBar(cdp) {
  return JSON.parse(await evaluate(cdp, `JSON.stringify((() => {
    const el = document.querySelector('.search-bar--top');
    if (!el) return { present: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      present: true,
      visible: cs.display !== 'none',
      position: cs.position,
      left: Math.round(r.left),
      width: Math.round(r.width),
      radius: cs.borderRadius,
      backdrop: (cs.backdropFilter && cs.backdropFilter !== 'none') ? cs.backdropFilter : 'none',
      input: document.querySelector('.search-bar--top .search-input')?.value ?? null,
      dropdown: !!document.querySelector('.search-history--dropdown'),
    };
  })())`));
}

/** 详情页返回钮状态（桌面端平时隐藏，鼠标移到图片上才浮出） */
async function backState(cdp) {
  return JSON.parse(await evaluate(cdp, `(() => {
    const b = document.querySelector('.detail-back-home');
    if (!b) return JSON.stringify({ present: false });
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return JSON.stringify({
      present: true,
      opacity: Number(cs.opacity).toFixed(2),
      pointer: cs.pointerEvents,
      left: Math.round(r.left),
      top: Math.round(r.top),
    });
  })()`));
}

/**
 * 在搜索框里输入并提交。
 * React 受控输入认的是原生 value setter + input 事件（直接 input.value = … 无效）；
 * 输入后要等一次渲染，submit 才能读到新 query（闭包里的旧值）。
 */
async function searchFor(cdp, q) {
  const typed = await evaluate(cdp, `(() => {
    const input = document.querySelector('.search-bar--top .search-input');
    if (!input) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(q)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  })()`);
  if (typed !== 'OK') return typed;
  await sleep(400);
  return evaluate(cdp, `(() => {
    const input = document.querySelector('.search-bar--top .search-input');
    if (!input?.form) return 'NO_FORM';
    input.form.requestSubmit();
    return 'OK';
  })()`);
}

const TABS = ['推荐', '排行', '我', '搜索'];

async function collect(cdp) {
  return evaluate(cdp, `JSON.stringify({
    title: document.title,
    brokenImgs: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src.slice(0, 100)),
    imgCount: document.querySelectorAll('img').length,
    cookieNotice: document.querySelector('.cookie-notice')?.innerText || null,
    storedCookieLen: (JSON.parse(localStorage.getItem('settings') || '{}').pixivCookie || '').length,
    bodyStart: document.body.innerText.slice(0, 200).replace(/\\n+/g, ' | '),
  })`);
}

function summarize() {
  say('──────── 汇总 ────────');
  say(`console.error / 未捕获异常: ${consoleErrors.length}`);
  for (const e of consoleErrors) say('  ERR:', e);
  say(`HTTP 4xx/5xx: ${badStatus.length}`);
  for (const s of [...new Set(badStatus)]) say('  HTTP', s);
  say(`网络失败: ${netFailed.length}`);
  for (const f of [...new Set(netFailed)]) say('  FAIL', f);
  say(`console.warn: ${consoleWarns.length}`);
  for (const w of [...new Set(consoleWarns)]) say('  WARN:', w.slice(0, 160));
  const bad = consoleErrors.length + badStatus.length;
  say(bad ? `❌ 发现 ${bad} 条异常` : '✅ 无异常');
  return bad;
}

// ── 场景 ───────────────────────────────────────────────────
const SCENARIOS = {
  /** 冒烟：启动 + 遍历四个 tab + 滚动，抓日志，有 error 就非 0 退出 */
  async smoke(cdp) {
    await sleep(4000);
    say('四个 tab 依次点击:');
    for (const [i, label] of TABS.entries()) {
      if (label === '搜索') {
        // 桌面端点侧边栏「搜索」= 在当前页面上浮出搜索框（不跳页），提交后才进结果页
        say(`  点「${label}」-> ${await clickText(cdp, label)}`);
        await sleep(1500);
        say(`  唤起态: ${JSON.stringify(await probeSearchBar(cdp))}`);
        await shot(cdp, `01-tab-${i}-${label}-composer`);
        say(`  输入关键词并回车 -> ${await searchFor(cdp, '初音ミク')}`);
        await sleep(3500);
        say(`  结果页: ${JSON.stringify(await probeSearchBar(cdp))}`);
        await shot(cdp, `01-tab-${i}-${label}`);
        continue;
      }
      say(`  点「${label}」-> ${await clickText(cdp, label)}`);
      await sleep(3500);
      await shot(cdp, `01-tab-${i}-${label}`);
    }
    await clickText(cdp, '推荐');
    await sleep(3000);
    await evaluate(cdp, `(() => { const sc = document.querySelector('.app-content') || document.scrollingElement; sc.scrollTop = 700; })()`);
    await sleep(2500);
    await shot(cdp, '02-discover-scrolled');
    say('页面状态:', await collect(cdp));
  },

  /** 报告：冒烟 + Cookie 生效 / 破图 / 收藏页诊断 */
  async report(cdp) {
    await sleep(4500);
    say('初始状态:', await collect(cdp));

    say(`点「排行」-> ${await clickText(cdp, '排行')}`);
    await sleep(6000);
    say('排行:', await collect(cdp));
    await shot(cdp, '10-ranking');

    say(`点「我」-> ${await clickText(cdp, '我')}`);
    await sleep(2500);
    say(`点「收藏」-> ${await clickText(cdp, '收藏')}`);
    await sleep(5000);
    say('收藏:', await collect(cdp));
    await shot(cdp, '11-favorites');
  },

  /** 宽图详情：宽图走「图在上、信息在下」的上下布局，竖图保持左右分栏（窄列会把宽图挤瘪） */
  async wideDetail(cdp) {
    await sleep(4500);
    const openBy = async (predicate) => evaluate(cdp, `(() => {
      const pane = [...document.querySelectorAll('.tab-pane')].find(p => p.style.display !== 'none') || document;
      const el = [...pane.querySelectorAll('.grid-item')].find(n => {
        const i = n.querySelector('img');
        return i && ${predicate};
      });
      if (!el) return 'NO_ITEM';
      el.click(); return 'OK';
    })()`);

    const probe = async () => JSON.parse(await evaluate(cdp, `new Promise(res => {
      let n = 0;
      const t = setInterval(() => {
        n++;
        const c = document.querySelector('.char-state-content');
        const m = document.querySelector('.detail-media-stack');
        if (c && m && m.getBoundingClientRect().height > 50) {
          clearInterval(t);
          const a = document.querySelector('.detail-author-panel');
          const box = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width) }; };
          const img = m.querySelector('img');
          res(JSON.stringify({
            wideClass: c.classList.contains('char-state-content--wide'),
            media: box(m),
            author: box(a),
            authorBelow: a.getBoundingClientRect().top >= m.getBoundingClientRect().bottom - 1,
            imgW: img ? Math.round(img.getBoundingClientRect().width) : null,
          }));
        } else if (n > 40) { clearInterval(t); res('TIMEOUT'); }
      }, 250);
    })`));

    say(`宽图 -> ${await openBy('i.naturalWidth > i.naturalHeight * 1.15')}`);
    say('  宽图布局:', JSON.stringify(await probe()));
    say('  返回钮（未悬停）:', JSON.stringify(await backState(cdp)));
    await shot(cdp, '40-wide-detail');

    // 鼠标移到图片上 → 返回钮浮出。CSS :hover / :has() 只能靠真实指针事件验，
    // 页面里 dispatchEvent 假造的 mouseover 不会让 :hover 生效。
    const pt = JSON.parse(await evaluate(cdp, `(() => {
      const r = document.querySelector('.detail-media-stack').getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 140) });
    })()`));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
    await sleep(500);
    say('  返回钮（悬停图片）:', JSON.stringify(await backState(cdp)));
    await shot(cdp, '40b-back-hover');
    await evaluate(cdp, `document.querySelector('.detail-back-home')?.click()`);
    await sleep(1500);

    say(`竖图 -> ${await openBy('i.naturalHeight > i.naturalWidth * 1.15')}`);
    say('  竖图布局:', JSON.stringify(await probe()));
    await shot(cdp, '41-tall-detail');
  },

  /** 桌面侧边栏：二级页签 / 覆盖层常驻 / 点导航关覆盖层 */
  async sidebar(cdp) {
    await sleep(4500);
    const probe = async () => JSON.parse(await evaluate(cdp, `JSON.stringify({
      sideNav: getComputedStyle(document.querySelector('.side-nav')).display,
      tabBar: getComputedStyle(document.querySelector('.tab-bar')).display,
      items: [...document.querySelectorAll('.side-nav-item')].map(b => b.textContent.trim()).join('/'),
      active: [...document.querySelectorAll('.side-nav-item.active')].map(b => b.textContent.trim()).join('/'),
      overlay: (() => {
        const el = document.querySelector('.detail-overlay, .settings-overlay');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width) };
      })(),
      sidebarCoveredByOverlay: (() => {
        const nav = document.querySelector('.side-nav').getBoundingClientRect();
        const top = document.elementFromPoint(nav.left + nav.width / 2, nav.top + nav.height / 2);
        return !document.querySelector('.side-nav').contains(top);
      })(),
    })`));

    say('初始:', JSON.stringify(await probe()));

    say(`点「我」-> ${await clickText(cdp, '我')}`);
    await sleep(3000);
    await shot(cdp, '20-me');
    say('  点我后:', JSON.stringify(await probe()));

    say(`点二级项「收藏」-> ${await clickText(cdp, '收藏')}`);
    await sleep(3500);
    await shot(cdp, '21-me-bookmarks');
    say('  切子页签后:', JSON.stringify(await probe()));

    // 打开详情 → 侧边栏应仍可见可点
    await clickText(cdp, '推荐');
    await sleep(3500);
    const opened = await evaluate(cdp, `(() => {
      const el = document.querySelector('.grid-item');
      if (!el) return 'NO_GRID';
      el.click(); return 'OK';
    })()`);
    say(`打开详情 -> ${opened}`);
    await sleep(4000);
    await shot(cdp, '22-detail');
    say('  详情打开:', JSON.stringify(await probe()));

    // 详情开着时点侧边栏切 tab → 详情应关闭
    say(`详情开着点「排行」-> ${await clickText(cdp, '排行')}`);
    await sleep(3500);
    await shot(cdp, '23-after-nav');
    say('  切 tab 后:', JSON.stringify(await probe()));

    // 设置覆盖层同理（按文字选，别用 nth —— 侧边栏页脚先后加过「下载」）
    say(`打开设置 -> ${await evaluate(cdp, `(() => {
      const el = [...document.querySelectorAll('.side-nav-item')].find(b => b.textContent.trim().startsWith('设置'));
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK';
    })()`)}`);
    await sleep(2500);
    await shot(cdp, '24-settings');
    say('  设置打开:', JSON.stringify(await probe()));

    // 设置开着点「搜索」：搜索框要顶掉设置（否则被设置(70)盖住，点了像没反应）
    say(`设置开着点「搜索」-> ${await clickText(cdp, '搜索')}`);
    await sleep(1500);
    say('  搜索唤起态:', JSON.stringify({
      ...(await probeSearchBar(cdp)),
      settingsOpen: await evaluate(cdp, `!!document.querySelector('.settings-overlay')`),
    }));
    await shot(cdp, '24b-search-composer');
    say(`  按 Esc -> ${await evaluate(cdp, `(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'OK';
    })()`)}`);
    await sleep(700);
    say('  Esc 后:', JSON.stringify(await probeSearchBar(cdp)));

    // 侧边栏的下载入口：无任务时也应能打开（旧实现无任务直接 return null）
    say(`侧边栏点「下载」-> ${await evaluate(cdp, `(() => {
      const el = [...document.querySelectorAll('.side-nav-item')].find(b => b.textContent.trim().startsWith('下载'));
      if (!el) return 'NOT_FOUND';
      // 已经是开着的就别再点（按钮是 toggle，会关掉）
      if (!document.querySelector('.dialog-overlay[data-variant="download"]')) el.click();
      return 'OK';
    })()`)}`);
    await sleep(2000);
    await shot(cdp, '25-downloads');
    say('  下载管理:', await evaluate(cdp, `JSON.stringify({
      open: !!document.querySelector('.dialog-overlay[data-variant="download"]'),
      panelBg: (() => { const p = document.querySelector('.dialog-overlay[data-variant="download"] .dialog-panel'); return p ? getComputedStyle(p).backgroundColor : null; })(),
      text: document.querySelector('.dialog-overlay[data-variant="download"]')?.innerText.replace(/\\n+/g, ' | ').slice(0, 120) ?? null,
    })`));
  },

  /** 响应式断点：逐档宽度检查导航形态切换与关键几何（手机端回归就靠它） */
  async responsive(cdp) {
    await sleep(4000);
    // 桌面端「搜索」先浮出搜索框（不跳页），提交后才进结果页；
    // 必须真提交一次，让搜索页成为当前 tab —— 否则切到手机宽度时栏会隐藏、探针变 null
    await clickText(cdp, '搜索');
    await sleep(1800);
    say(`唤起态: ${JSON.stringify(await probeSearchBar(cdp))}`);
    say(`输入并回车 -> ${await searchFor(cdp, '初音ミク')}`);
    await sleep(3000);

    // 899/900 卡断点；1100x500 是"宽而矮"，用来确认横屏紧凑规则没有误命中桌面
    const cases = [[420, 820], [899, 820], [900, 820], [1100, 820], [1100, 500], [1600, 900]];
    for (const [w, h] of cases) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false,
      });
      await sleep(900);
      const r = await evaluate(cdp, `JSON.stringify({
        sideNav: getComputedStyle(document.querySelector('.side-nav')).display,
        tabBar: getComputedStyle(document.querySelector('.tab-bar')).display,
        appDir: getComputedStyle(document.querySelector('.app')).flexDirection,
        appMaxW: getComputedStyle(document.querySelector('.app')).maxWidth,
        contentPadBottom: getComputedStyle(document.querySelector('.app-content')).paddingBottom,
        searchLeft: (() => { const e = document.querySelector('.search-bar--top'); return e ? Math.round(e.getBoundingClientRect().left) : null; })(),
        searchBar: (() => {
          const el = document.querySelector('.search-bar--top');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return {
            visible: cs.display !== 'none',
            position: cs.position,
            width: Math.round(el.getBoundingClientRect().width),
            radius: cs.borderRadius,
            glass: cs.backdropFilter && cs.backdropFilter !== 'none' ? 'yes' : 'no',
          };
        })(),
      })`);
      say(`${String(w).padStart(4)}x${h}: ${r}`);
      await shot(cdp, `30-${w}x${h}`);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  },

  /**
   * 下载管理专项：注入三种状态的假任务，验证分组与字节/速度显示。
   * 必须配 --dev（要用 window.__pixivViewer 这个 DEV 专用调试口）。
   * 为什么不真下载：桌面端点「下载」会弹**原生保存框**，自动化没法关掉它。
   */
  async downloads(cdp) {
    await sleep(4000);
    const injected = await evaluate(cdp, `(() => {
      const dm = window.__pixivViewer?.downloadMonitor;
      if (!dm) return 'NO_DEV_GLOBAL（记得加 --dev）';
      // 进行中：给真实量级的字节数，能看出「已下载/总大小 · 速度」
      const a = dm.start('demo_run', { illustId: '111', page: 0, title: '进行中的作品', kind: 'image', message: '下载原图' });
      a.setProgress(12, { loaded: 400000, total: 3200000 });
      setTimeout(() => a.setProgress(46, { loaded: 1500000, total: 3200000 }), 400);
      // 动图进行中
      const b = dm.start('demo_gif', { illustId: '222', page: 0, title: '动图进行中', kind: 'gif', message: '下载 ZIP' });
      b.setProgress(70, { loaded: 2100000, total: 3000000 });
      // 失败：必须先 start（recordFailure 只登记已存在任务的 retry 信息，无任务时是空操作）
      const f1 = dm.start('demo_fail1', { illustId: '333', page: 0, title: '失败的作品 A', kind: 'image', message: '下载原图' });
      f1.recordFailure({ illustId: '333', page: 0, title: '失败的作品 A', kind: 'image' });
      f1.finish(false, 'HTTP 502');
      const f2 = dm.start('demo_fail2', { illustId: '444', page: 0, title: '失败的作品 B', kind: 'image', message: '下载原图' });
      f2.recordFailure({ illustId: '444', page: 0, title: '失败的作品 B', kind: 'image' });
      f2.finish(false, '网络超时');
      // 已完成（finish 后 8s 才会被自动移除）
      const c = dm.start('demo_done', { illustId: '555', page: 0, title: '已完成的作品', kind: 'image' });
      c.finish(true);
      return 'OK statuses=' + dm.getSnapshot().jobs.map(j => j.key + ':' + j.status).join(',');
    })()`);
    say(`注入假任务 -> ${injected}`);
    await sleep(1200);

    await evaluate(cdp, `window.__pixivViewer && (() => {
      const el = [...document.querySelectorAll('.side-nav-item')].find(b => b.textContent.trim().startsWith('下载'));
      el?.click();
    })()`);
    await sleep(1200);

    // 先取状态再截图：已完成任务 8s 后会被 downloadMonitor 自动移除，
    // 而截图可能重试掉 45s，先截图会把「已完成」组等没了
    const state = await evaluate(cdp, `(() => {
      const modal = document.querySelector('.dialog-overlay[data-variant="download"]');
      if (!modal) return 'NOT_OPEN';
      return JSON.stringify({
        groups: [...modal.querySelectorAll('.download-group')].map(g => g.querySelector('.download-group-head')?.innerText.replace(/\\n/g, ' ')),
        rows: [...modal.querySelectorAll('.download-row')].map(r => r.innerText.replace(/\\n/g, ' | ')),
        head: modal.querySelector('.download-head')?.innerText.replace(/\\n/g, ' | '),
        panelBg: getComputedStyle(modal.querySelector('.dialog-panel')).backgroundColor,
        panelW: Math.round(modal.querySelector('.dialog-panel').getBoundingClientRect().width),
      });
    })()`);
    say('下载管理:', state);
    await shot(cdp, '40-downloads');

    // 收尾：把假任务清掉，别留到下次运行
    await evaluate(cdp, `(() => {
      const dm = window.__pixivViewer?.downloadMonitor;
      if (!dm) return;
      for (const j of dm.getSnapshot().jobs) dm.finish(j.key, true);
      dm.clearFinished();
    })()`);
  },

  /**
   * 键盘可达性：侧边栏方向键导航、覆盖层焦点移入/归还、Esc 关闭。
   * 这些用肉眼看截图是看不出来的，只能靠断言。
   */
  async a11y(cdp) {
    await sleep(4000);
    const out = await evaluate(cdp, `(async () => {
      const t = (ms) => new Promise(r => setTimeout(r, ms));
      const who = () => (document.activeElement?.textContent || document.activeElement?.className || document.activeElement?.tagName || '?').trim().slice(0, 16);
      const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      const out = [];

      const items = [...document.querySelectorAll('.side-nav-item')];
      if (!items.length) return ['NO_SIDEBAR（视口 <900px？）'];
      items[0].focus();
      out.push('起点=' + who());
      key(items[0], 'ArrowDown'); out.push('Down→' + who());
      key(document.activeElement, 'ArrowDown'); out.push('Down→' + who());
      key(document.activeElement, 'End'); out.push('End→' + who());
      key(document.activeElement, 'Home'); out.push('Home→' + who());
      key(document.activeElement, 'ArrowUp'); out.push('Up 回绕→' + who());

      // 设置：打开 → 焦点进覆盖层 → Esc 关闭 → 焦点还给侧边栏按钮
      const sBtn = [...document.querySelectorAll('.side-nav-item')].find(b => b.textContent.trim().startsWith('设置'));
      sBtn.focus(); sBtn.click(); await t(700);
      const ov = document.querySelector('.settings-overlay');
      out.push('设置打开：' + (ov?.contains(document.activeElement) ? '焦点在覆盖层内' : '焦点不在（' + who() + '）'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await t(700);
      out.push('Esc：' + (document.querySelector('.settings-overlay') ? '仍在' : '已关') + '，焦点=' + who());

      // 下载抽屉
      const dBtn = [...document.querySelectorAll('.side-nav-item')].find(b => b.textContent.trim().startsWith('下载'));
      dBtn.focus(); dBtn.click(); await t(700);
      const dlg = document.querySelector('.dialog-overlay[data-variant="download"]');
      out.push('抽屉：' + (dlg?.contains(document.activeElement) ? '焦点在抽屉内' : '焦点不在（' + who() + '）')
        + '，role=' + (dlg?.querySelector('.dialog-panel')?.getAttribute('role') || '无'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await t(700);
      out.push('Esc：' + (document.querySelector('.dialog-overlay[data-variant="download"]') ? '仍在' : '已关') + '，焦点=' + who());
      return out;
    })()`);
    for (const line of (Array.isArray(out) ? out : [out])) say('  ' + line);
  },

  /**
   * 灯箱：逐张 slide 比对「托底小图」与「原图」的实际绘制区域。
   * 两者用的是同一个 item，比例应当一致；不一致就会看起来像「两张图」——
   * 桌面端媒体区高度放到 100vh 后 contain 留白更多，错位更容易看出来。
   */
  async lightbox(cdp) {
    await sleep(4000);
    const opened = await evaluate(cdp, `(async () => {
      const t = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = (l) => [...document.querySelectorAll('.side-nav-item')].find(b => b.textContent.trim().startsWith(l));
      const waitFor = async (sel, n = 25) => { for (let i = 0; i < n; i++) { if (document.querySelector(sel)) return true; await t(700); } return false; };
      nav('推荐').click();
      if (!await waitFor('.grid-item')) return 'NO_GRID';
      document.querySelector('.grid-item').click();
      if (!await waitFor('.image-detail-hero')) return 'NO_DETAIL';
      document.querySelector('.image-detail-hero').click();
      if (!await waitFor('.lightbox-img-wrap')) return 'NO_LIGHTBOX';
      // 等原图真的解码出来，否则量到的是 0×0
      for (let i = 0; i < 30; i++) {
        const f = document.querySelector('.lightbox-img-full');
        if (f && f.naturalWidth > 0) break;
        await t(700);
      }
      return 'OK';
    })()`);
    say(`打开灯箱 -> ${opened}`);

    const rows = await evaluate(cdp, `(() => {
      const W = window.innerWidth;
      // object-fit:contain 下算出实际绘制的像素矩形（不是元素盒子）
      const drawn = (e) => {
        if (!e || !e.naturalWidth) return null;
        const r = e.getBoundingClientRect();
        const s = Math.min(r.width / e.naturalWidth, r.height / e.naturalHeight);
        const w = Math.round(e.naturalWidth * s), h = Math.round(e.naturalHeight * s);
        return { nat: [e.naturalWidth, e.naturalHeight],
          box: [r.left, r.top, r.width, r.height].map(Math.round),
          drawn: [Math.round(r.left + (r.width - w) / 2), Math.round(r.top + (r.height - h) / 2), w, h] };
      };
      return JSON.stringify([...document.querySelectorAll('.lightbox-img-wrap')].map((wrap, i) => {
        const wr = wrap.getBoundingClientRect();
        return { i, onScreen: wr.left < W && wr.right > 0,
          under: drawn(wrap.querySelector('.lightbox-img-underlay')),
          full: drawn(wrap.querySelector('.lightbox-img-full')) };
      }));
    })()`);
    try {
      for (const s of JSON.parse(rows)) {
        if (!s.onScreen) continue;
        const u = s.under?.drawn, f = s.full?.drawn;
        const same = u && f && u[0] === f[0] && u[1] === f[1] && u[2] === f[2] && u[3] === f[3];
        // 托底图被比例校验拿掉是**期望结果**（各站缩略图常是裁剪过的），不算失败
        const verdict = !s.under ? '无托底（比例不符已隐藏 ✔）' : (same ? '重合 ✔' : '❌ 不重合');
        say(`slide#${s.i} 托底 nat=${s.under?.nat} box=${JSON.stringify(s.under?.box)} 绘制=${JSON.stringify(u)}`
          + ` | 原图 nat=${s.full?.nat} box=${JSON.stringify(s.full?.box)} 绘制=${JSON.stringify(f)}`
          + ` → ${verdict}`);
      }
    } catch { say('解析失败:', rows); }
    await shot(cdp, '50-lightbox');
  },

  /** 在渲染进程求值（支持 async IIFE，会自动 await） */
  async eval(cdp) {
    if (!scenarioArg) throw new Error('用法: driver.mjs eval "<js 表达式>"');
    await sleep(4000);
    const v = await evaluate(cdp, scenarioArg);
    say('结果:', typeof v === 'string' ? v : JSON.stringify(v));
  },

  /** 只截图 */
  async shot(cdp) {
    await sleep(4000);
    await shot(cdp, scenarioArg || `shot-${Date.now()}`);
  },
};

// ── 主流程 ─────────────────────────────────────────────────
(async () => {
  const fn = SCENARIOS[scenario];
  if (!fn) {
    console.error(`未知场景: ${scenario}（可选: ${Object.keys(SCENARIOS).join(', ')}）`);
    process.exit(2);
  }
  let cdp = null;
  try {
    cdp = await boot();
    await fn(cdp);
    process.exitCode = summarize() ? 1 : 0;
  } catch (e) {
    say('FATAL:', e.message);
    process.exitCode = 1;
  } finally {
    fs.mkdirSync(path.join(ROOT, 'log'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'log', 'desktop-driver.log'), lines.join('\n'));
    try { cdp?.close(); } catch { /* ignore */ }
    await sleep(300);
    killTree();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
  }
})();

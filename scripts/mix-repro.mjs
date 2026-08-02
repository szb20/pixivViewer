// 临时诊断：限速复现「上一张未加载完即点下一张」的串图问题
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9231;
const APP_URL = 'http://127.0.0.1:5182/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(path.join(tmpdir(), 'pixiv-mix-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });

async function main() {
  let ok = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`); if (r.ok) { ok = true; break; } } catch {}
    await sleep(250);
  }
  if (!ok) throw new Error('Chrome 未就绪');

  const target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(APP_URL)}`, { method: 'PUT' }).then(r => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg.result); }
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res?.result?.value;
  };
  const waitFor = async (expr, timeoutMs = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = await evaluate(expr);
      if (v) return v;
      await sleep(500);
    }
    return null;
  };

  await send('Runtime.enable');
  await send('Network.enable');
  await sleep(3000);

  // 打开排行第一个条目
  await waitFor(`document.querySelectorAll('.grid-item').length > 0`, 60000);
  await evaluate(`document.querySelector('.grid-item').click()`);
  await waitFor(`!!document.querySelector('.detail-overlay')`, 15000);
  const blocks = await waitFor(`document.querySelectorAll('.image-detail-hero').length`, 15000);
  console.log('详情页图片块数量:', blocks);

  // 开启限速：原图加载变慢，模拟「上一张还没加载完」
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: 60 * 1024,
    uploadThroughput: 60 * 1024,
  });

  // 趁原图未加载完，快速点第二个块（当前图）打开灯箱
  if (blocks > 1) {
    await evaluate(`document.querySelectorAll('.image-detail-hero')[1].click()`);
    await waitFor(`!!document.querySelector('.lightbox-overlay')`, 10000);
    await sleep(800);
    const lightboxState = await evaluate(`(function(){
      const slides = [...document.querySelectorAll('.lightbox-slide')];
      return {
        slideCount: slides.length,
        visibleImgs: slides.map((s, i) => {
          const img = s.querySelector('img');
          if (!img) return { i, img: null };
          const r = img.getBoundingClientRect();
          return {
            i,
            src: (img.src || '').slice(-60),
            complete: img.complete,
            naturalW: img.naturalWidth,
            visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth,
          };
        }),
      };
    })()`);
    console.log('灯箱状态:', JSON.stringify(lightboxState, null, 2));
  }

  // 再等一会儿看灯箱滑到第 2 张后的状态
  if (blocks > 1) {
    await sleep(2500);
    const later = await evaluate(`(function(){
      const imgs = [...document.querySelectorAll('.lightbox-slide img')].filter(Boolean);
      return imgs.map(img => ({
        src: (img.src || '').slice(-50),
        complete: img.complete,
        rect: (() => { const r = img.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })(),
      }));
    })()`);
    console.log('2.5s 后灯箱 img:', JSON.stringify(later, null, 2));
  }

  console.log('exceptions:', JSON.stringify(errors));
  ws.close();
  chrome.kill();
}

main().catch(err => { console.error('脚本失败:', err.message); chrome.kill(); process.exit(1); });

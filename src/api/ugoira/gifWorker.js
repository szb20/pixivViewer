/**
 * GIF 编码 Worker — quantize/applyPalette/writeFrame 全部在 Worker 线程执行。
 *
 * 帧像素由主线程解码图片后 transfer 进来（Image 解码依赖 DOM，只能在主线程），
 * 每帧用完即丢，Worker 内存峰值 ≈ 一帧像素 + 已编码输出。
 *
 * 协议（主线程 ↔ Worker）：
 *   主 → Worker: { type:'start', buffer, w, h, delays }        （首帧像素，transfer）
 *   Worker → 主: { type:'needFrame', i }                        （请求第 i 帧像素）
 *   主 → Worker: { type:'frame', i, buffer }                    （transfer 回来）
 *   Worker → 主: { type:'progress', pct } | { type:'done', buffer } | { type:'error', message }
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

/** 等待主线程送来第 i 帧像素 */
const pendingFrames = new Map();

self.onmessage = (e) => {
  const { type } = e.data || {};
  if (type === 'start') {
    run(e.data).catch(err => {
      self.postMessage({ type: 'error', message: err?.message || String(err) });
    });
  } else if (type === 'frame' && pendingFrames.has(e.data.i)) {
    pendingFrames.get(e.data.i)(e.data.buffer);
    pendingFrames.delete(e.data.i);
  }
};

async function run({ buffer, w, h, delays }) {
  const n = delays.length;
  // 第 0 帧先量化出共享调色板（全 GIF 复用，色偏最小化）
  const palette = quantize(new Uint8ClampedArray(buffer), 256);
  const encoder = new GIFEncoder();

  let idx = applyPalette(new Uint8ClampedArray(buffer), palette);
  encoder.writeFrame(idx, w, h, { palette, delay: delays[0] || 80, first: true, transparent: false });
  self.postMessage({ type: 'progress', pct: Math.min(90, 60 + Math.round((1 / n) * 30)) });

  for (let i = 1; i < n; i++) {
    const buf = await new Promise(resolve => {
      pendingFrames.set(i, resolve);
      self.postMessage({ type: 'needFrame', i });
    });
    idx = applyPalette(new Uint8ClampedArray(buf), palette);
    encoder.writeFrame(idx, w, h, { palette, delay: delays[i] || 80, first: false, transparent: false });
    self.postMessage({ type: 'progress', pct: Math.min(90, 60 + Math.round(((i + 1) / n) * 30)) });
  }

  encoder.finish();
  const bytes = encoder.bytes();
  // 输出 transfer 回主线程，免拷贝
  self.postMessage({ type: 'done', buffer: bytes.buffer }, [bytes.buffer]);
}

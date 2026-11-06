/**
 * GIF 编码（gifenc）— 取像素 + 共享调色板逐帧流水写入。
 *
 * CPU 密集部分（quantize/applyPalette/writeFrame）在 Worker 线程执行（gifWorker.js），
 * 主线程只负责帧图解码（Image/canvas 依赖 DOM）与像素缓冲 transfer；
 * 保存 50 帧动图期间 UI 不再卡顿。Worker 不可用（老 WebView）时回退主线程编码。
 */

/** 加载图片并取像素数据（用于 GIF 编码） */
export function loadImageToPixels(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resolve({ imageData, w: canvas.width, h: canvas.height });
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('帧图片加载失败'));
    img.src = src;
  });
}

/**
 * gifenc 编码（Worker 版）：共享调色板 + 逐帧流水写入。
 * getFrame(i) 返回 { imageData, w, h }；每帧写入后立即释放像素，内存峰值≈一帧。
 * @returns {Promise<Uint8Array>} GIF 字节
 */
export async function encodeFramesToGif(first, getFrame, delays, w, h, onProgress) {
  // Worker 建不起来（老 WebView / 非浏览器环境）→ 主线程回退
  let worker = null;
  try {
    worker = new Worker(new URL('./gifWorker.js', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  if (!worker) return encodeFramesToGifInline(first, getFrame, delays, w, h, onProgress);

  try {
    return await new Promise((resolve, reject) => {
      let gotWorkerMsg = false;
      worker.onmessage = (e) => {
        gotWorkerMsg = true;
        const { type } = e.data || {};
        if (type === 'needFrame') {
          // 主线程解码第 i 帧，像素缓冲 transfer 给 Worker（零拷贝，主线程侧立即失引用）
          getFrame(e.data.i).then(pixels => {
            const buffer = pixels.imageData.data.buffer;
            worker.postMessage({ type: 'frame', i: e.data.i, buffer }, [buffer]);
          }).catch(reject);
        } else if (type === 'progress') {
          onProgress?.(e.data.pct);
        } else if (type === 'done') {
          resolve(new Uint8Array(e.data.buffer));
        } else if (type === 'error') {
          reject(new Error(e.data.message));
        }
      };
      worker.onerror = async (e) => {
        if (!gotWorkerMsg) {
          // 老 WebView 不支持 module Worker 时构造不抛错，import 在线程内
          // 异步失败走这里 —— 回退主线程编码（首帧 buffer 已 transfer
          // 失效，重新解码第 0 帧）
          try {
            const first0 = await getFrame(0);
            resolve(await encodeFramesToGifInline(first0, getFrame, delays, w, h, onProgress));
          } catch (err) {
            reject(err);
          }
          return;
        }
        reject(new Error(e.message || 'GIF Worker 异常'));
      };
      const firstBuffer = first.imageData.data.buffer;
      worker.postMessage(
        { type: 'start', buffer: firstBuffer, w, h, delays },
        [firstBuffer],
      );
    });
  } finally {
    worker.terminate();
  }
}

/** 主线程回退实现（无 Worker 环境用） */
async function encodeFramesToGifInline(first, getFrame, delays, w, h, onProgress) {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const palette = quantize(first.imageData.data, 256);
  const encoder = new GIFEncoder();
  for (let i = 0; i < delays.length; i++) {
    const frame = i === 0 ? first : await getFrame(i);
    const idx = applyPalette(frame.imageData.data, palette);
    encoder.writeFrame(idx, w, h, {
      palette,
      delay: delays[i] || 80,
      first: i === 0,
      transparent: false,
    });
    frame.imageData = null; // 释放该帧像素，避免全量驻留内存
    onProgress?.(Math.min(90, 60 + Math.round(((i + 1) / delays.length) * 30)));
  }
  encoder.finish();
  return encoder.bytes();
}

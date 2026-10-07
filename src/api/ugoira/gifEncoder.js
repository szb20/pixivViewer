/**
 * GIF 编码（gifenc）— 取像素 + 共享调色板逐帧流水写入。
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
 * gifenc 编码：共享调色板 + 逐帧流水写入。
 * getFrame(i) 返回 { imageData, w, h }；每帧写入后立即释放像素，内存峰值≈一帧。
 */
export async function encodeFramesToGif(first, getFrame, delays, w, h, onProgress) {
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

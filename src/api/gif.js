/**
 * 浏览器版 Ugoira 动图加载 — 下载 ZIP → 解帧 → 生成 blob URL 帧序列。
 *
 * 链路：/ajax/illust/{id}/ugoira_meta 取元数据 →
 *       /pixiv-zip 代理下载 ZIP → jszip 解压 → 每帧生成 blob URL。
 * UgoiraPlayer 约定 result.frames = [{ path, delay }]。
 */
import JSZip from 'jszip';
import { browserFetch } from './pixiv.js';
import {
  PixivEntity, PixivRepository, getFS, getSettings, safeFileName, CACHE_DIR, ensureDirectory,
} from '../pixiv-assistant/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('gif');

const cache = new Map(); // illustId -> { frames, meta }
/** 帧缓存上限 — 超限淘汰最旧条目并回收其 blob URL，避免会话内无限累积 */
const MAX_CACHE = 12;
const repo = new PixivRepository();

/** 回收帧序列里的 blob URL（幂等，已回收的无副作用） */
function releaseFrames(frames) {
  if (!Array.isArray(frames)) return;
  for (const f of frames) {
    if (f?.path?.startsWith('blob:')) URL.revokeObjectURL(f.path);
  }
}

/** 淘汰最旧缓存条目并回收其帧 blob URL */
function evictOldest() {
  const oldestKey = cache.keys().next().value;
  if (!oldestKey) return;
  const entry = cache.get(oldestKey);
  releaseFrames(entry?.frames);
  cache.delete(oldestKey);
}

async function getPixivCookie() {
  const s = await getSettings();
  return String(s.pixivCookie || '').trim().replace(/^PHPSESSID=/i, '');
}

export async function fetchUgoiraFrames(illustId, onProgress, opts = {}) {
  const id = String(illustId);
  const cached = cache.get(id);
  if (cached) {
    if (!opts.force) return cached;
    // 强制刷新：释放旧帧并重新下载（旧的 blob URL 可能已被播放器侧淘汰回收）
    releaseFrames(cached.frames);
    cache.delete(id);
  }

  const cookie = await getPixivCookie();
  const h = {};
  if (cookie) h['Cookie'] = `PHPSESSID=${cookie}`;

  onProgress?.(5);
  const metaResp = await browserFetch(`/ajax/illust/${id}/ugoira_meta`, { headers: h });
  const body = metaResp?.body;
  if (!body?.originalSrc || !body?.frames?.length) {
    throw new Error(body?.error_message || 'GIF 元数据未找到');
  }
  onProgress?.(20);

  const zipResp = await fetch(`/pixiv-zip/${encodeURIComponent(body.originalSrc)}`);
  if (!zipResp.ok) throw new Error(`ZIP 下载失败: HTTP ${zipResp.status}`);
  const zipBuf = await zipResp.arrayBuffer();
  onProgress?.(55);

  const zip = await JSZip.loadAsync(zipBuf);
  const entries = Object.keys(zip.files)
    .filter(name => !zip.files[name].dir)
    .sort();

  const urls = [];
  for (let i = 0; i < entries.length; i++) {
    const blob = await zip.files[entries[i]].async('blob');
    urls.push(URL.createObjectURL(blob));
  }
  onProgress?.(85);

  // 按元数据 frames 顺序组装（file 名匹配，匹配不到按压缩包顺序兜底）
  const frames = body.frames.map((f, i) => {
    const fileName = String(f.file || '');
    const idx = fileName
      ? entries.findIndex(n => n.toLowerCase().endsWith(fileName.toLowerCase()))
      : -1;
    const sourceIndex = idx >= 0 ? idx : Math.min(i, urls.length - 1);
    return { path: urls[sourceIndex], delay: f.delay || 100 };
  });

  onProgress?.(100);
  const result = { frames, meta: body };
  if (cache.size >= MAX_CACHE) evictOldest();
  cache.set(id, result);
  return result;
}

/** 加载图片并取像素数据（用于 GIF 编码） */
function loadImageToPixels(src) {
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

/** gifenc 编码：共享调色板 + 逐帧写入 */
async function encodeFramesToGif(pixelFrames, delays, w, h) {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const allPixels = pixelFrames.map(d => new Uint8ClampedArray(d.imageData.data.buffer.slice(0)));
  const palette = quantize(allPixels[0], 256);
  const encoder = new GIFEncoder();
  for (let i = 0; i < allPixels.length; i++) {
    const idx = applyPalette(allPixels[i], palette);
    encoder.writeFrame(idx, w, h, {
      palette,
      delay: delays[i] || 80,
      first: i === 0,
      transparent: false,
    });
  }
  encoder.finish();
  return encoder.bytes();
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 保存 Ugoira 动图到相册：取帧 → gifenc 编码 → 写文件 + 元数据。
 * 幂等：已保存（pixiv:{id}:0）直接返回。
 */
export async function saveGifToAlbum(item, onProgress) {
  if (!item?.illustId) return { error: '缺少 illustId' };
  const sid = String(item.illustId);

  const existing = await repo.find(PixivEntity.makeId(sid, 0));
  if (existing?.fileName && existing.isSaved) {
    return { success: true, idempotent: true, cached: true, fileName: existing.fileName };
  }

  const FS = await getFS();
  if (!FS) return { error: 'filesystem_unavailable' };

  try {
    onProgress?.(5);
    const { frames } = await fetchUgoiraFrames(sid, onProgress);
    if (!frames?.length) return { error: '无帧数据' };

    // 逐帧取像素（复用已下载的 blob URL，不重复下载 ZIP）
    const pixelFrames = [];
    for (let i = 0; i < frames.length; i++) {
      pixelFrames.push(await loadImageToPixels(frames[i].path));
      if ((i + 1) % 10 === 0) onProgress?.(Math.min(55, 35 + i + 1));
    }
    const w = pixelFrames[0].w;
    const h = pixelFrames[0].h;
    onProgress?.(60);

    const bytes = await encodeFramesToGif(pixelFrames, frames.map(f => f.delay), w, h);
    onProgress?.(90);
    const base64 = bytesToBase64(bytes);

    const finalAuthor = item.authorName || item.author || sid;
    const finalTitle = item.title || sid;
    const gifFileName = `pixiv_${sid}_g0_[${safeFileName(finalAuthor)}]_[${safeFileName(finalTitle)}].gif`
      .replace(/_+/g, '_')
      .slice(0, 200);

    // 写文件（DOCUMENTS/TeyvatWhisper 相册目录）
    await ensureDirectory(FS, CACHE_DIR, 'DOCUMENTS');
    await FS.plugin.writeFile({ path: `${CACHE_DIR}/${gifFileName}`, data: base64, directory: 'DOCUMENTS' });

    // 写元数据（动图统一存 page 0）
    const entity = new PixivEntity({
      id: PixivEntity.makeId(sid, 0),
      illustId: sid,
      pageIndex: 0,
      type: 'gif',
      state: 'saved',
      fileName: gifFileName,
      title: finalTitle,
      author: finalAuthor,
      authorName: finalAuthor,
      authorId: item.authorId || '',
      pixivUrl: item.pixivUrl || `https://www.pixiv.net/artworks/${sid}`,
      frameCount: frames.length,
      frames: frames.map((f, i) => ({ file: `frame_${i}`, delay: f.delay || 80 })),
      cachedAt: Date.now(),
      size: bytes.length,
      likedAt: 0,
    });
    await repo.save(entity);

    onProgress?.(100);
    return { success: true, cached: true, fileName: gifFileName, entity };
  } catch (e) {
    log.error('[saveGifToAlbum] 失败:', e.message);
    return { error: `GIF 保存失败: ${e.message}` };
  }
}

/**
 * 浏览器版 Ugoira 动图加载 — 下载 ZIP → 解帧 → 生成 blob URL 帧序列。
 *
 * 链路：/ajax/illust/{id}/ugoira_meta 取元数据 →
 *       /pixiv-zip 代理下载 ZIP → jszip 解压 → 每帧生成 blob URL。
 * UgoiraPlayer 约定 result.frames = [{ path, delay }]。
 */
import JSZip from 'jszip';
import { Unzip } from 'fflate';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { browserFetch, prodFetch } from './pixiv.js';
import {
  PixivEntity, PixivRepository, getSettings, safeFileName, getFS, CACHE_DIR,
} from '../pixiv-assistant/index.js';
import { createLogger } from '../utils/logger.js';
import { downloadMonitor } from '../utils/downloadMonitor.js';
import { exportToGallery, galleryHasFile } from '../pixiv-assistant/capacitor/gallery.js';
import { scheduleMetaBackup } from '../pixiv-assistant/capacitor/metaBackup.js';

const log = createLogger('gif');
const IS_DEV = import.meta.env.DEV;

const cache = new Map(); // illustId -> { frames, meta }
/** 帧缓存上限 — 超限淘汰最旧条目并回收其 blob URL，避免会话内无限累积。
 *  播放器层（FrameAnimPlayer）与 API 层共用此缓存，容量取两者原上限中较大值。 */
const MAX_CACHE = 12;
/** 进行中的下载注册表：illustId → { promise, listeners: Set, lastPct }，跨组件共享进度与去重 */
const inflight = new Map();
const repo = new PixivRepository();
/** 同一动图的保存去重（并发触发只编码一次） */
const saveInFlight = new Map(); // illustId → Promise

/** ---- 磁盘帧缓存（ZIP 落盘，重启后可直读，避免重复下载） ---- */
const ZIP_CACHE_SUBDIR = `${CACHE_DIR}/ugoira`; // 位于 Directory.Data 下
const ZIP_CACHE_MAX = 12;                        // 磁盘最多保留几个动图
const ZIP_CACHE_MAX_BYTES = 40 * 1024 * 1024;    // 超过 40MB 的 ZIP 不落盘（读取内存风险）
const ZIP_CACHE_CHUNK = 2 * 1024 * 1024;         // 读写块大小 2MB，避免整包 base64 内存峰值

function zipCachePath(id) { return `${ZIP_CACHE_SUBDIR}/ugoira_${id}.zip`; }
function metaCachePath(id) { return `${ZIP_CACHE_SUBDIR}/ugoira_${id}.meta.json`; }

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

/** 读取已缓存的帧结果（未命中返回 null）— 供播放器层恢复帧，避免双重缓存/重复下载 */
export function getCachedFrames(illustId) {
  return cache.get(String(illustId)) || null;
}

/** 清除某个作品的帧缓存并回收其 blob URL（加载失败时供播放器层调用，强制下次重新下载） */
export function clearFrameCache(illustId) {
  const id = String(illustId);
  const entry = cache.get(id);
  if (entry) {
    releaseFrames(entry.frames);
    cache.delete(id);
  }
}

async function getPixivCookie() {
  const s = await getSettings();
  return String(s.pixivCookie || '').trim().replace(/^PHPSESSID=/i, '');
}

/** dev 走 Vite 代理，prod 走 CapacitorHttp（原生直连，绕过 WebView CORS） */
const apiFetch = IS_DEV ? browserFetch : prodFetch;

/** 查询 ugoira 元数据（只发小请求，不下载 ZIP） */
async function fetchUgoiraMeta(id) {
  const cookie = await getPixivCookie();
  const h = {};
  if (cookie) h['Cookie'] = `PHPSESSID=${cookie}`;
  const metaResp = await apiFetch(`/ajax/illust/${id}/ugoira_meta`, { headers: h });
  const body = metaResp?.body;
  if (!body?.originalSrc || !body?.frames?.length) {
    throw new Error(body?.error_message || 'GIF 元数据未找到');
  }
  return body;
}

/** 动图保存到相册时的稳定文件名（由 illustId/作者/标题决定，同名即同图） */
function buildGifFileName(sid, author, title) {
  return `pixiv_${sid}_g0_[${safeFileName(author)}]_[${safeFileName(title)}].gif`
    .replace(/_+/g, '_')
    .slice(0, 200);
}

/**
 * i.pximg.net → i.pixiv.re：CDN 要求 pixiv Referer（浏览器 fetch 无法设置，WebView 会 403），
 * 而 i.pixiv.re 无需该 Referer 且带 Access-Control-Allow-Origin: *，与图片缩略图同一通道。
 */
function proxyZipUrl(url) {
  return String(url || '').replace(/i\.pximg\.net/gi, 'i.pixiv.re');
}

/** 拼接多个 Uint8Array */
function concatBytes(parts) {
  const total = parts.reduce((a, c) => a + (c?.byteLength || 0), 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    if (!p?.byteLength) continue;
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** 分块 base64 → 字节（避免一次性生成整份巨型二进制字符串） */
function base64ToBytes(base64) {
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const byteLen = ((base64.length / 4) * 3) - pad;
  const bytes = new Uint8Array(byteLen);
  let pos = 0;
  for (let i = 0; i < base64.length; i += 0x8000) {
    const chunk = atob(base64.slice(i, i + 0x8000));
    for (let j = 0; j < chunk.length; j++) bytes[pos++] = chunk.charCodeAt(j);
  }
  return bytes;
}

/**
 * 创建 fflate 流式解压器（网络流 / 磁盘分块读共用）。
 * feed(chunk, final) 逐块喂入；finish() 在喂完后按 meta.frames 顺序组装帧。
 */
function createUnzipper(meta, onFrameProgress) {
  const mime = meta.mime_type || 'image/jpeg';
  const entryUrls = new Map();
  const entryOrder = [];
  const partsByName = new Map();
  let failErr = null;

  const unzip = new Unzip();
  unzip.onfile = (file) => {
    if (!file?.name || file.name.endsWith('/')) return;
    const parts = [];
    partsByName.set(file.name, parts);
    file.ondata = (err, data, final) => {
      if (err) { failErr = err; return; }
      parts.push(data);
      if (final) {
        partsByName.delete(file.name);
        entryUrls.set(file.name, URL.createObjectURL(new Blob(parts, { type: mime })));
        entryOrder.push(file.name);
        onFrameProgress?.(entryOrder.length, Math.max(1, meta.frames.length));
      }
    };
    file.start();
  };

  return {
    feed(chunk, final) {
      if (failErr) return;
      try {
        unzip.push(chunk, final);
      } catch (e) {
        failErr = e;
      }
    },
    finish() {
      if (failErr) throw failErr;
      // 按 meta.frames 顺序组装（优先文件名匹配，失败按压缩包顺序兜底）
      const frames = meta.frames.map((f, i) => {
        const fileName = String(f.file || '').toLowerCase();
        let frameUrl = fileName ? entryUrls.get(fileName) : null;
        if (!frameUrl && fileName) {
          const match = entryOrder.find(n => n.toLowerCase().endsWith(fileName));
          frameUrl = match ? entryUrls.get(match) : null;
        }
        if (!frameUrl) {
          frameUrl = entryUrls.get(entryOrder[Math.min(i, entryOrder.length - 1)]);
        }
        if (!frameUrl) throw new Error(`ZIP 缺少帧文件 ${f.file || i}`);
        return { path: frameUrl, delay: f.delay || 100 };
      });
      return frames;
    },
  };
}

/** 确保 ZIP 缓存目录存在 */
async function ensureZipCacheDir(fs) {
  try {
    await fs.plugin.mkdir({ path: ZIP_CACHE_SUBDIR, directory: 'DATA', recursive: true });
  } catch { /* 已存在 */ }
}

/** 磁盘缓存 LRU：保留最近 ZIP_CACHE_MAX 个，删除最旧的 zip + meta */
async function trimZipCache(fs) {
  try {
    const { files } = await fs.plugin.readdir({ path: ZIP_CACHE_SUBDIR, directory: 'DATA' });
    const zips = (files || []).filter(f => String(f.name).endsWith('.zip'));
    if (zips.length <= ZIP_CACHE_MAX) return;
    const withTime = [];
    for (const f of zips) {
      try {
        const st = await fs.plugin.stat({ path: `${ZIP_CACHE_SUBDIR}/${f.name}`, directory: 'DATA' });
        withTime.push({ name: f.name, mtime: st?.mtime || 0 });
      } catch {
        withTime.push({ name: f.name, mtime: 0 });
      }
    }
    withTime.sort((a, b) => a.mtime - b.mtime);
    for (let i = 0; i < withTime.length - ZIP_CACHE_MAX; i++) {
      const name = withTime[i].name;
      await fs.plugin.deleteFile({ path: `${ZIP_CACHE_SUBDIR}/${name}`, directory: 'DATA' }).catch(() => {});
      await fs.plugin.deleteFile({
        path: `${ZIP_CACHE_SUBDIR}/${name.replace(/\.zip$/, '.meta.json')}`,
        directory: 'DATA',
      }).catch(() => {});
    }
  } catch (e) {
    log.debug('[gif] 清理 ZIP 缓存失败:', e?.message || e);
  }
}

/**
 * 把已下载的 ZIP 分块写入磁盘缓存（appendFile 每次 ~2MB，避免整包 base64 内存峰值）。
 * 同时写入 meta.json（含帧顺序/延迟，离线也能直接读）。
 */
async function saveZipToDisk(id, meta, chunks) {
  try {
    if (!Array.isArray(chunks) || chunks.length === 0) return false;
    const totalBytes = chunks.reduce((a, c) => a + (c?.byteLength || 0), 0);
    if (totalBytes > ZIP_CACHE_MAX_BYTES) return false;
    const fs = await getFS();
    if (!fs?.plugin) return false;
    await ensureZipCacheDir(fs);

    const zipPath = zipCachePath(id);
    await fs.plugin.deleteFile({ path: zipPath, directory: 'DATA' }).catch(() => {});

    const pieces = [];
    let acc = 0;
    const flush = async () => {
      if (!pieces.length) return;
      const buf = concatBytes(pieces);
      await fs.plugin.appendFile({ path: zipPath, data: bytesToBase64(buf), directory: 'DATA' });
      pieces.length = 0;
      acc = 0;
    };
    for (const c of chunks) {
      pieces.push(c);
      acc += c.byteLength;
      if (acc >= ZIP_CACHE_CHUNK) await flush();
    }
    await flush();

    await fs.plugin.writeFile({
      path: metaCachePath(id),
      data: JSON.stringify(meta),
      directory: 'DATA',
      encoding: 'utf8', // 不指定会被当成 base64 解码，JSON 会变成乱码
    });
    await trimZipCache(fs);
    log.info(`[gif] ZIP 已写入磁盘缓存: ${id} ${totalBytes} bytes`);
    return true;
  } catch (e) {
    log.debug('[gif] 保存 ZIP 缓存失败:', e?.message || e);
    return false;
  }
}

/** 删除指定动图的磁盘缓存 */
async function deleteZipFromDisk(id) {
  try {
    const fs = await getFS();
    if (!fs?.plugin) return;
    await fs.plugin.deleteFile({ path: zipCachePath(id), directory: 'DATA' }).catch(() => {});
    await fs.plugin.deleteFile({ path: metaCachePath(id), directory: 'DATA' }).catch(() => {});
  } catch { /* ignore */ }
}

/**
 * 把原版无损 ZIP 从磁盘缓存复制到相册目录（Pictures/TeyvatWhisper/，与保存的图片/动图同目录），
 * 作为卸载后仍保留的无损副本（尽力而为：缓存被 LRU 淘汰或读取失败就跳过）。
 */
async function saveLosslessZipToGallery(sid) {
  try {
    const isNative = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
    const S = isNative ? Capacitor?.Plugins?.GallerySaver : null;
    if (!S) return;
    const fs = await getFS();
    if (!fs?.plugin) return;
    const zipPath = zipCachePath(sid);
    const raw = await fs.plugin.readFile({ path: zipPath, directory: 'DATA' }).catch(() => null);
    if (!raw) return;
    const base64 = typeof raw === 'string' ? raw : raw.data || '';
    if (!base64) return;
    await S.saveDownload({
      fileName: `pixiv_${sid}_ugoira.zip`,
      data: base64,
      mimeType: 'application/zip',
    });
    log.info(`[gif] 已备份无损 ZIP: ${sid}`);
  } catch (e) {
    log.debug('[gif] 备份无损 ZIP 失败:', e?.message || e);
  }
}

/**
 * 从磁盘缓存读回帧：分块读 ZIP + 流式解压（readFileInChunks 空块即文件结束），
 * 不生成整包 base64，内存峰值 ≈ 单块 + 帧。
 */
async function loadFramesFromDisk(id) {
  try {
    const fs = await getFS();
    if (!fs?.plugin) return null;

    const metaRaw = await fs.plugin
      .readFile({ path: metaCachePath(id), directory: 'DATA', encoding: 'utf8' })
      .catch(() => null);
    if (!metaRaw) return null;
    let meta;
    try {
      meta = JSON.parse(typeof metaRaw.data === 'string' ? metaRaw.data : metaRaw);
    } catch {
      return null;
    }
    if (!meta?.frames?.length) return null;

    const zipPath = zipCachePath(id);
    const unzipper = createUnzipper(meta);
    let failErr = null;
    await new Promise((resolve, reject) => {
      fs.plugin.readFileInChunks(
        { path: zipPath, directory: 'DATA', chunkSize: ZIP_CACHE_CHUNK },
        (chunkRead, err) => {
          if (err) { failErr = err; reject(err); return; }
          const data = chunkRead?.data;
          if (!data) { resolve(); return; } // 空块 = 文件结束
          try {
            unzipper.feed(base64ToBytes(typeof data === 'string' ? data : data.data || ''), false);
          } catch (e) {
            failErr = e;
            reject(e);
          }
        },
      );
    });
    if (failErr) throw failErr;
    unzipper.feed(new Uint8Array(0), true);
    const frames = unzipper.finish();
    log.info(`[gif] 磁盘缓存命中: ${id} ${frames.length} 帧`);
    return { frames, meta };
  } catch (e) {
    log.debug('[gif] 读取 ZIP 缓存失败:', e?.message || e);
    return null;
  }
}

/**
 * 流式下载 + 边下边解（prod 主路径）：
 * fetch reader 分块收 ZIP → 逐块喂给 fflate Unzip → 每帧解出立即生成 blob URL。
 * 全程不落地整包（无 base64 整包转码，不会撑爆 WebView 堆），进度 20→85 连续推进。
 */
async function streamUgoira(id, meta, onProgress) {
  const url = proxyZipUrl(meta.originalSrc);

  const ctrl = new AbortController();
  // 停滞检测：只在「没有任何数据到达」超过 90 秒时才中止；
  // 慢速但持续有数据的下载不会被误杀。
  const STALL_MS = 90000;
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(), STALL_MS);
  };
  armStall(); // 连接阶段也算停滞计时
  let resp;
  try {
    resp = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    throw new Error(`ZIP 请求失败: ${e.name === 'AbortError' ? '下载停滞超时' : e.message}`);
  } finally {
    clearTimeout(stallTimer);
  }
  if (!resp.ok) throw new Error(`ZIP 下载失败: HTTP ${resp.status}`);
  if (!resp.body?.getReader) throw new Error('当前 WebView 不支持流式读取');

  const total = Number(resp.headers.get('Content-Length')) || 0;
  // 只有尺寸可接受才收集字节块用于落盘（避免为大包额外占内存）
  const collectForCache = total === 0 || total <= ZIP_CACHE_MAX_BYTES;
  const zipChunks = collectForCache ? [] : null;
  const reader = resp.body.getReader();
  let received = 0;
  let lastPct = -1;
  const report = (pct) => {
    const p = Math.max(20, Math.min(85, Math.round(pct)));
    if (p !== lastPct) {
      lastPct = p;
      onProgress?.(p);
    }
  };

  return await new Promise((resolve, reject) => {
    const fail = (err) => {
      try { ctrl.abort(); } catch { /* ignore */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const unzipper = createUnzipper(meta, (done, totalFrames) => {
      report(55 + (done / totalFrames) * 30);
    });

    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength || 0;
          armStall(); // 有数据到达 → 重置停滞计时
          zipChunks?.push(value);
          unzipper.feed(value, false);
          if (total > 0) report(20 + (received / total) * 35);
        }
        clearTimeout(stallTimer);
        unzipper.feed(new Uint8Array(0), true);
        const frames = unzipper.finish();

        // 落盘缓存（不阻塞播放；失败只记日志）
        if (zipChunks) {
          saveZipToDisk(id, meta, zipChunks).catch(() => {});
        }
        resolve(frames);
      } catch (e) {
        clearTimeout(stallTimer);
        fail(e.name === 'AbortError' ? new Error('ZIP 下载停滞超时') : e);
      }
    })();
  });
}

/**
 * 缓冲路径（dev 代理 / prod 回退）：JSZip 整包解压。
 * 下载阶段进度停在 35，拿到包后 55 → 解帧 85。
 */
async function extractZipFrames(zipBuf, body, onProgress) {
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
  return body.frames.map((f, i) => {
    const fileName = String(f.file || '');
    const idx = fileName
      ? entries.findIndex(n => n.toLowerCase().endsWith(fileName.toLowerCase()))
      : -1;
    const sourceIndex = idx >= 0 ? idx : Math.min(i, urls.length - 1);
    return { path: urls[sourceIndex], delay: f.delay || 100 };
  });
}

/**
 * 下载 Ugoira ZIP（兜底缓冲版）。
 * dev：走 /pixiv-zip 代理；prod：CapacitorHttp 原生下载（可带 pixiv Referer），分块 base64 解码。
 */
async function downloadZip(url) {
  if (IS_DEV) {
    const zipResp = await fetch(`/pixiv-zip/${encodeURIComponent(url)}`);
    if (!zipResp.ok) throw new Error(`ZIP 下载失败: HTTP ${zipResp.status}`);
    return await zipResp.arrayBuffer();
  }

  const resp = await CapacitorHttp.request({
    method: 'GET',
    url,
    headers: { Referer: 'https://www.pixiv.net/' },
    responseType: 'blob',
    connectTimeout: 120000,
    readTimeout: 120000,
  });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`ZIP 下载失败: HTTP ${resp.status}`);
  const raw = resp.data;
  let base64 = typeof raw === 'string' ? raw : (raw?.data || '');
  base64 = base64.includes(',') ? base64.split(',')[1] : base64;
  if (!base64) throw new Error('ZIP 下载失败: 数据为空');
  // 分块解码，避免一次性生成整份巨型二进制字符串（降低峰值内存）
  return base64ToBytes(base64).buffer;
}

export async function fetchUgoiraFrames(illustId, onProgress, opts = {}) {
  const id = String(illustId);
  const cached = cache.get(id);
  if (cached) {
    if (!opts.force) {
      onProgress?.(100);
      return cached;
    }
    // 强制刷新：释放旧帧并重新下载（旧的 blob URL 可能已被播放器侧淘汰回收）
    releaseFrames(cached.frames);
    cache.delete(id);
    deleteZipFromDisk(id); // 磁盘缓存也一并作废，避免强制刷新后读到旧包
  }

  // 同一作品的下载已在路上 → 挂上自己的进度监听，等同一个 promise（避免重复下载）
  const existing = inflight.get(id);
  if (existing && !opts.force) {
    if (onProgress) {
      existing.listeners.add(onProgress);
      onProgress?.(existing.lastPct);
    }
    try {
      return await existing.promise;
    } finally {
      if (onProgress) existing.listeners.delete(onProgress);
    }
  }

  const entry = { listeners: new Set(), lastPct: 0, promise: null };
  if (onProgress) entry.listeners.add(onProgress);
  const broadcast = (pct) => {
    // 进度只增不减：下载进度（20-55）与逐帧解压进度（55-85）两路交错上报，
    // 取最大值避免进度环来回跳。
    const p = Math.max(entry.lastPct, pct || 0);
    if (p === entry.lastPct) return;
    entry.lastPct = p;
    for (const fn of entry.listeners) {
      try { fn?.(p); } catch { /* 单个监听器异常不影响其他 */ }
    }
  };

  entry.promise = (async () => {
    // 1) 磁盘缓存（未强制刷新时优先）
    if (!opts.force) {
      broadcast(15);
      const disk = await loadFramesFromDisk(id);
      if (disk?.frames?.length) {
        broadcast(100);
        const result = { frames: disk.frames, meta: disk.meta };
        if (cache.size >= MAX_CACHE) evictOldest();
        cache.set(id, result);
        return result;
      }
    }

    // 2) 网络下载（meta + ZIP）
    broadcast(5);
    const body = await fetchUgoiraMeta(id);
    broadcast(20);

    // 下载前先腾出缓存空间，避免与 ZIP 解码叠加造成 OOM
    while (cache.size >= MAX_CACHE) evictOldest();

    let frames;
    if (IS_DEV) {
      const zipBuf = await downloadZip(body.originalSrc);
      frames = await extractZipFrames(zipBuf, body, broadcast);
    } else {
      try {
        frames = await streamUgoira(id, body, broadcast);
        log.info(`[fetchUgoiraFrames] 流式解帧成功: ${id} ${frames.length} 帧`);
      } catch (e) {
        log.info('[fetchUgoiraFrames] 流式下载失败，回退缓冲下载:', e.message);
        const zipBuf = await downloadZip(body.originalSrc);
        frames = await extractZipFrames(zipBuf, body, broadcast);
        saveZipToDisk(id, body, [new Uint8Array(zipBuf)]).catch(() => {});
      }
    }

    broadcast(100);
    const result = { frames, meta: body };
    if (cache.size >= MAX_CACHE) evictOldest();
    cache.set(id, result);
    return result;
  })();

  inflight.set(id, entry);
  try {
    return await entry.promise;
  } finally {
    inflight.delete(id);
  }
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

/**
 * gifenc 编码：共享调色板 + 逐帧流水写入。
 * getFrame(i) 返回 { imageData, w, h }；每帧写入后立即释放像素，内存峰值≈一帧。
 */
async function encodeFramesToGif(first, getFrame, delays, w, h, onProgress) {
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
  const inFlight = saveInFlight.get(sid);
  if (inFlight) return inFlight;
  const mon = downloadMonitor.start(`${sid}_0`, {
    illustId: sid,
    page: 0,
    title: item.title || sid,
    kind: 'gif',
    message: '下载动图',
  });
  const wrapped = (pct) => {
    if (pct == null) return;
    mon.setProgress(Math.round(pct));
    onProgress?.(pct);
  };
  const promise = doSaveGifToAlbum(item, wrapped).then(
    (r) => {
      mon.finish(!!r?.success, r?.error || '');
      if (r?.success) saveLosslessZipToGallery(sid).catch(() => {});
      return r;
    },
    (e) => { mon.finish(false, e?.message || '动图保存失败'); throw e; },
  );
  saveInFlight.set(sid, promise);
  promise.finally(() => saveInFlight.delete(sid)).catch(() => {});
  return promise;
}

/** 动图保存实体（动图统一存 page 0） */
function buildGifEntity(sid, item, gifFileName, finalAuthor, finalTitle, meta, size = 0, likedAt = 0) {
  return new PixivEntity({
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
    frameCount: meta?.frames?.length || 0,
    frames: (meta?.frames || []).map((f, i) => ({ file: `frame_${i}`, delay: f.delay || 80 })),
    cachedAt: Date.now(),
    size,
    likedAt,
  });
}

async function doSaveGifToAlbum(item, onProgress) {
  const sid = String(item.illustId);
  const existing = await repo.find(PixivEntity.makeId(sid, 0));
  if (existing?.fileName && existing.isSaved) {
    return { success: true, idempotent: true, cached: true, fileName: existing.fileName };
  }
  // 若已有轻记录（toggleLike 创建、无文件），重建时保留其 likedAt，避免喜欢标记被抹掉
  const preserveLikedAt = existing?.likedAt || 0;

  // 目标文件名由 illustId/作者/标题决定，先算出来：
  // 系统相册已有同名文件 → 跳过 ZIP 下载与 GIF 编码，直接补元数据
  const finalAuthor = item.authorName || item.author || sid;
  const finalTitle = item.title || sid;
  const gifFileName = buildGifFileName(sid, finalAuthor, finalTitle);

  if (!existing?.fileName && await galleryHasFile(gifFileName)) {
    let meta = null;
    try { meta = await fetchUgoiraMeta(sid); } catch { /* 元数据拿不到也不阻塞 */ }
    const entity = buildGifEntity(sid, item, gifFileName, finalAuthor, finalTitle, meta, 0, preserveLikedAt);
    await repo.save(entity);
    scheduleMetaBackup();
    onProgress?.(100);
    return { success: true, idempotent: true, cached: true, fileName: gifFileName, skipped: true, entity };
  }

  try {
    onProgress?.(5);
    const { frames } = await fetchUgoiraFrames(sid, onProgress);
    if (!frames?.length) return { error: '无帧数据' };

    // 逐帧流水：第 0 帧先量化出共享调色板，其余帧按需加载并立即释放
    const first = await loadImageToPixels(frames[0].path);
    const w = first.w;
    const h = first.h;
    const getFrame = async (i) => {
      const pixels = await loadImageToPixels(frames[i].path);
      if ((i + 1) % 10 === 0) onProgress?.(Math.min(55, 35 + i + 1));
      return pixels;
    };

    const bytes = await encodeFramesToGif(first, getFrame, frames.map(f => f.delay), w, h, onProgress);
    const base64 = bytesToBase64(bytes);

    // 只导出系统相册（MediaStore / Pictures/TeyvatWhisper），不写私有副本（避免双写）
    await exportToGallery(base64, gifFileName, 'image/gif');

    // 写元数据（动图统一存 page 0）
    const entity = buildGifEntity(sid, item, gifFileName, finalAuthor, finalTitle, { frames }, bytes.length, preserveLikedAt);
    await repo.save(entity);
    scheduleMetaBackup();

    onProgress?.(100);
    return { success: true, cached: true, fileName: gifFileName, entity };
  } catch (e) {
    log.error('[saveGifToAlbum] 失败:', e.message);
    return { error: `GIF 保存失败: ${e.message}` };
  }
}

/**
 * Ugoira（Pixiv 动图）加载编排。
 *
 * 链路：内存 LRU → 磁盘 ZIP 缓存 → ugoira_meta →
 *       网络流式下载解帧（prod 主路径）/ 缓冲下载整包解帧（dev / 回退）→ blob URL 帧序列。
 * FrameAnimPlayer 约定 result.frames = [{ path, delay }]。
 *
 * 保存链路（取帧 → GIF 编码 → 相册导出）在 storageService（pixiv-assistant/capacitor），
 * 不在本模块 —— 本模块只管「看」，storageService 只管「存」。
 */
import { createLogger } from '../../utils/logger.js';
import { getCachedFrames, clearFrameCache, setFrames, trimToRoom } from './framesCache.js';
import { fetchUgoiraMeta } from './meta.js';
import { loadFramesFromDisk, deleteZipFromDisk, saveZipToDisk } from './zipDiskCache.js';
import { proxyZipUrl, streamUgoira, downloadZip } from './zipDownload.js';
import { extractFramesFromBuffer } from './unzip.js';

const log = createLogger('ugoira');
const IS_DEV = import.meta.env.DEV;

/** 进行中的下载注册表：illustId → { promise, listeners: Set, lastPct }，跨组件共享进度与去重 */
const inflight = new Map();

export async function fetchUgoiraFrames(illustId, onProgress, opts = {}) {
  const id = String(illustId);
  const cached = getCachedFrames(id);
  if (cached) {
    if (!opts.force) {
      onProgress?.(100);
      return cached;
    }
    // 强制刷新：释放旧帧并重新下载（旧的 blob URL 可能已被播放器侧淘汰回收）
    clearFrameCache(id);
    deleteZipFromDisk(id); // 磁盘缓存也一并作废，避免强制刷新后读到旧包
  }

  // 同一作品的下载已在路上 → 挂上自己的进度监听，等同一个 promise（避免重复下载）
  const existing = inflight.get(id);
  // force 刷新同样复用在途下载：否则会与正在进行的下载并发写同一个磁盘缓存包
  if (existing) {
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
        setFrames(id, result);
        return result;
      }
    }

    // 2) 网络下载（meta + ZIP）
    broadcast(5);
    const body = await fetchUgoiraMeta(id);
    broadcast(20);

    // 下载前先腾出缓存空间，避免与 ZIP 解码叠加造成 OOM
    trimToRoom();

    let frames;
    if (IS_DEV) {
      const zipBuf = await downloadZip(proxyZipUrl(body.originalSrc));
      frames = await extractFramesFromBuffer(zipBuf, body, broadcast);
    } else {
      try {
        frames = await streamUgoira(id, body, broadcast);
        log.info(`流式解帧成功: ${id} ${frames.length} 帧`);
      } catch (e) {
        log.info('流式下载失败，回退缓冲下载:', e.message);
        const zipBuf = await downloadZip(proxyZipUrl(body.originalSrc));
        frames = await extractFramesFromBuffer(zipBuf, body, broadcast);
        saveZipToDisk(id, body, [new Uint8Array(zipBuf)]).catch(() => { });
      }
    }

    broadcast(100);
    const result = { frames, meta: body };
    setFrames(id, result);
    return result;
  })();

  inflight.set(id, entry);
  try {
    return await entry.promise;
  } finally {
    inflight.delete(id);
  }
}

export { getCachedFrames, clearFrameCache };

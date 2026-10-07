/**
 * Ugoira 帧内存缓存（LRU）。
 *
 * 播放器层（FrameAnimPlayer）与 API 层共用此缓存，容量取两者历史上限中较大值。
 * 超限淘汰最旧条目并回收其 blob URL，避免会话内无限累积。
 */
const cache = new Map(); // illustId -> { frames, meta }

/** 帧缓存上限 */
export const MAX_CACHE = 12;

/** 回收帧序列里的 blob URL（幂等，已回收的无副作用） */
export function releaseFrames(frames) {
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

/** 写入缓存（满则先淘汰一条再写） */
export function setFrames(illustId, result) {
  const id = String(illustId);
  if (cache.size >= MAX_CACHE) evictOldest();
  cache.set(id, result);
}

/** 腾出缓存余量（下载大 ZIP 前调用，避免解帧与帧缓存叠加造成 OOM） */
export function trimToRoom() {
  while (cache.size >= MAX_CACHE) evictOldest();
}

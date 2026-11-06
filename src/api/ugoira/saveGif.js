/**
 * 动图（Ugoira）保存用例 — 下载监控 + 幂等 → 相册同名跳过 → 取帧 → GIF 编码 → 相册导出 → 落库。
 *
 * 从 storageService（pixiv-assistant/capacitor）上提至 API 层：动图管线依赖
 * 网络取帧与 Worker 编码（api/ugoira），此前 storageService → api/ugoira →
 * capacitor/config 构成包级环、与「存储层在 API 层之下」的分层相反。
 * 现在方向单一：api → capacitor / utils / core。
 *
 * 只导出系统相册（MediaStore / Pictures/PixivViewer），不写私有副本（避免双写）。
 */
import { PixivEntity, PixivRepository } from '../../pixiv-assistant/index.js';
import {
  galleryHasFile, exportToGallery, isGalleryAvailable, scheduleMetaBackup, buildGifFileName,
} from '../../pixiv-assistant/index.js';
import { downloadMonitor } from '../../utils/downloadMonitor.js';
import { bytesToBase64 } from '../../utils/bytes.js';
import { createLogger } from '../../utils/logger.js';
import { fetchUgoiraFrames } from './index.js';
import { fetchUgoiraMeta } from './meta.js';
import { loadImageToPixels, encodeFramesToGif } from './gifEncoder.js';
import { backupLosslessZip } from './zipDiskCache.js';

const log = createLogger('saveGif');

// Repository 是 IndexedDB 之上的无状态映射器，独立实例与 storageService 内的等价
const repository = new PixivRepository();

/**
 * 动图保存编排：下载监控 + 失败登记（供下载管理一键重试），实际取帧/编码在 _doSaveGif。
 * 并发去重由 api/index.js 的 saveItem 完成（动图统一页 0，与静图共用 `${illustId}_0` 键）。
 * @param {object} item — 动图条目
 * @returns {Promise<{success?: boolean, error?: string, ...}>}
 */
export async function saveGifFromNetwork(item) {
  const sid = String(item.illustId);
  const mon = downloadMonitor.start(`${sid}_0`, {
    illustId: sid,
    page: 0,
    title: item.title || sid,
    kind: 'gif',
    message: '下载动图',
  });
  // 失败时登记完整重试信息（供下载管理一键重试）
  const failMeta = {
    illustId: sid,
    page: 0,
    type: 'gif',
    illustType: 2,
    originalUrl: item.originalUrl,
    mediumUrl: item.mediumUrl,
    thumbnailUrl: item.thumbnailUrl,
    title: item.title || sid,
    author: item.authorName || item.author || '',
    authorName: item.authorName || item.author || '',
    authorId: item.authorId || '',
    tags: item.tags,
  };
  const wrapped = (pct) => {
    if (pct == null) return;
    mon.setProgress(Math.round(pct));
  };
  try {
    const r = await _doSaveGif(item, wrapped);
    if (r?.success) {
      mon.finish(true);
      // 无损 ZIP 副本尽力而为：磁盘缓存被 LRU 淘汰或读取失败就跳过
      backupLosslessZip(sid).catch(() => { });
    } else {
      mon.recordFailure(failMeta);
      mon.finish(false, r?.error || '动图保存失败');
    }
    return r;
  } catch (e) {
    mon.recordFailure(failMeta);
    mon.finish(false, e?.message || '动图保存失败');
    throw e;
  }
}

/**
 * 动图保存实现：幂等 → 相册同名跳过 → 取帧 → gifenc 编码 → 导出相册 + 落库。
 */
async function _doSaveGif(item, onProgress) {
  const sid = String(item.illustId);
  // booru 站没有 Ugoira：只有 Pixiv 作品的 meta 接口存在，误入这里必然一路 404
  if (item.source && item.source !== 'pixiv') return { error: '该来源不支持动图' };
  const existing = await repository.find(PixivEntity.makeId(sid, 0));
  if (existing?.fileName && existing.isSaved) {
    // 和静态图 _promoteToSaved 同一条规矩：只信 state 位会让用户在系统相册里删掉图之后，
    // 再点保存永远返回 idempotent，补不回来。没有相册通道（桌面/浏览器）时维持原语义。
    if (!isGalleryAvailable() || await galleryHasFile(existing.fileName)) {
      return { success: true, idempotent: true, cached: true, fileName: existing.fileName };
    }
    log.info('动图相册副本缺失，重新导出:', existing.fileName);
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
    await repository.save(entity);
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

    // 导出结果必须看：桌面端「每次询问」时用户在系统保存框点取消、安卓 MediaStore 写失败
    // 都会返回 false。以前这里把返回值丢掉，于是磁盘上没有文件却记成 saved + 成功，
    // 之后幂等分支又只看状态位 —— 再也补不回来（静态图那边是一直检查 written 的）
    const exported = await exportToGallery(base64, gifFileName, 'image/gif');
    if (!exported) return { error: '写入相册失败' };

    // 写元数据（动图统一存 page 0）
    const entity = buildGifEntity(sid, item, gifFileName, finalAuthor, finalTitle, { frames }, bytes.length, preserveLikedAt);
    await repository.save(entity);
    scheduleMetaBackup();

    onProgress?.(100);
    return { success: true, cached: true, fileName: gifFileName, entity };
  } catch (e) {
    log.error('[_doSaveGif] 失败:', e.message);
    return { error: `GIF 保存失败: ${e.message}` };
  }
}

/**
 * 动图保存实体（动图统一存 page 0）。
 * @param {string} sid
 * @param {object} item — 原始条目（authorId / pixivUrl 等展示元数据）
 * @param {string} gifFileName
 * @param {string} finalAuthor
 * @param {string} finalTitle
 * @param {{frames?: Array}} [meta] — ugoira 元数据（相册同名跳过时可能拿不到 → frameCount 落 0）
 * @param {number} [size] — GIF 字节数
 * @param {number} [likedAt] — 重建轻记录时保留的喜欢时间戳
 * @returns {PixivEntity}
 */
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

/**
 * PixivStorageService — 业务编排层。
 *
 * 只负责编排，不执行具体操作。
 * 每行代码都应能看出「业务规则」而非「实现细节」。
 */
import { PixivEntity } from './entity.js';
import { PixivRepository } from './repository.js';
import { FileStore } from './fileStore.js';
import { NetworkStore } from './networkStore.js';
import { galleryHasFile, exportToGallery, isGalleryAvailable } from './gallery.js';
import { pixivReUrl, buildGifFileName } from '../core/utils.js';
import { fetchableImageUrls } from '../../sources/imageUrl.js';
import { createLogger } from '../../utils/logger.js';
import { downloadMonitor } from '../../utils/downloadMonitor.js';
import { scheduleMetaBackup } from './metaBackup.js';
import { fetchUgoiraFrames } from '../../api/ugoira/index.js';
import { fetchUgoiraMeta } from '../../api/ugoira/meta.js';
import { loadImageToPixels, encodeFramesToGif } from '../../api/ugoira/gifEncoder.js';
import { backupLosslessZip } from '../../api/ugoira/zipDiskCache.js';
import { bytesToBase64 } from '../../utils/bytes.js';

const log = createLogger('storageService');

export class PixivStorageService {
  constructor() {
    this.repository = new PixivRepository();
    this.fileStore = new FileStore();
    this.networkStore = new NetworkStore();
  }

  /**
   * 精确查找 entity；未命中且目标不是页 0 时，仅动图允许回退到页 0（动图统一存页 0），
   * 普通图片必须逐页精确匹配，否则本地复用时会把其它页的图片当成当前页显示。
   * @param {string} illustId
   * @param {number} pageIndex
   * @returns {Promise<PixivEntity|null>}
   */
  async _findEntity(illustId, pageIndex = 0) {
    const entity = await this.repository.find(PixivEntity.makeId(illustId, pageIndex));
    if (entity || pageIndex === 0) return entity;
    const gifEntity = await this.repository.find(PixivEntity.makeId(illustId, 0));
    return gifEntity?.isGif ? gifEntity : null;
  }

  /**
   * cached → saved：私有存储文件导出系统相册 + 元数据置 saved。
   *
   * 幂等性校验会实际确认相册里文件还在：只信 state 位会让「用户在系统相册删掉图后再点保存」
   * 永远返回 idempotent（UI 提示"已在相册中"且永不重新下载）。
   * @param {PixivEntity} entity — 必须已有 fileName
   * @returns {Promise<{success: boolean, entity?: PixivEntity, error?: string, idempotent?: boolean}>}
   */
  async _promoteToSaved(entity) {
    if (entity.state === 'saved') {
      // 桌面/浏览器没有相册通道：无法校验也不该判缺失，维持原幂等语义
      if (!isGalleryAvailable()) return { success: true, entity, idempotent: true };
      const stillThere = await galleryHasFile(entity.fileName);
      if (stillThere) return { success: true, entity, idempotent: true };
      // 相册副本已被删除 → 用应用内私有副本重新导出
      log.info('相册副本缺失，重新导出:', entity.fileName);
      const data = await this.fileStore.readData(entity);
      if (data && await exportToGallery(data, entity.fileName)) {
        return { success: true, entity };
      }
      // 私有副本也没了 → 交给上层重新下载
      return { success: false, error: 'file_missing' };
    }
    if (entity.state !== 'cached') {
      return { success: false, error: `invalid_state: expected cached, got ${entity.state}` };
    }
    const data = await this.fileStore.readData(entity);
    if (!data) return { success: false, error: 'file_copy_failed' };
    const exported = await exportToGallery(data, entity.fileName);
    if (!exported) return { success: false, error: 'file_copy_failed' };
    await this.repository.changeState(entity.id, 'saved');
    return { success: true, entity: entity.withState('saved') };
  }

  /**
   * 加载图片 blob URL。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{localUrl: string, data: string}|null>}
   */
  async load(illustId, pageIndex = 0) {
    const entity = await this._findEntity(illustId, pageIndex);
    if (!entity) return null;
    return await this.fileStore.load(entity);
  }

  /**
   * 按喜欢状态分页查询。
   * @param {number} offset
   * @param {number} limit
   * @returns {Promise<{items: PixivEntity[], total: number}>}
   */
  async listLiked(offset = 0, limit = 50) {
    return await this.repository.listLiked(offset, limit);
  }

  /**
   * 切换喜欢状态（可携带展示元数据，供「喜欢」页展示缩略图/标题）。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @param {object} [meta]
   */
  async toggleLike(illustId, pageIndex = 0, meta = {}) {
    const id = PixivEntity.makeId(illustId, pageIndex);
    const result = await this.repository.toggleLike(id, meta);
    if (result.success) scheduleMetaBackup();
    return result;
  }

  /**
   * 幂等设为喜欢。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @param {object} [meta]
   */
  async like(illustId, pageIndex = 0, meta = {}) {
    const id = PixivEntity.makeId(illustId, pageIndex);
    const result = await this.repository.like(id, meta);
    if (result.success) scheduleMetaBackup();
    return result;
  }

  /**
   * 幂等取消喜欢（不清除记录/文件，仅清 likedAt）。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   */
  async unlike(illustId, pageIndex = 0) {
    const id = PixivEntity.makeId(illustId, pageIndex);
    const result = await this.repository.unlike(id);
    if (result.success) scheduleMetaBackup();
    return result;
  }

  /**
   * 回填展示元数据（浏览时把完整缩略图 URL / 标题 / 作者 / tags 写回已保存/喜欢的记录）。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @param {object} meta
   * @returns {Promise<{updated: boolean}>}
   */
  async fillMeta(illustId, pageIndex = 0, meta = {}) {
    const id = PixivEntity.makeId(illustId, pageIndex);
    const result = await this.repository.fillMeta(id, meta);
    if (result?.updated) scheduleMetaBackup();
    return result;
  }

  /**
   * 回填缺失的展示元数据（缩略图/标题/作者等），供「喜欢」页网格展示。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @param {object} [meta]
   * @returns {Promise<{updated: boolean}>}
   */
  async backfillMeta(illustId, pageIndex = 0, meta = {}) {
    const id = PixivEntity.makeId(illustId, pageIndex);
    const r = await this.repository.backfillMeta(id, meta);
    if (r?.updated) scheduleMetaBackup();
    return r;
  }

  /**
   * 下载并保存到相册（原图优先）。
   *
   * 与 save() 的区别：save() 只做 cached→saved 状态迁移（记录必须已存在），
   * 本方法在记录不存在时直接下载图片并创建 saved 记录，是 UI 层「保存」的唯一入口。
   *
   * @param {object} item — 图片条目（含 illustId / _pageIndex / originalUrl / mediumUrl / title 等）
   * @returns {Promise<{success: boolean, entity?: PixivEntity, error?: string, idempotent?: boolean}>}
   */
  async saveFromNetwork(item) {
    if (!item?.illustId) return { success: false, error: 'invalid_item' };
    // 动图（Ugoira）：只有 Pixiv 有此类型，走独立通道（ZIP 解帧 → GIF 编码 → 相册导出）；
    // booru 条目恒为静态图，继续走下面的原图下载分支。
    const isPixiv = !item.source || item.source === 'pixiv';
    if (isPixiv && (item.type === 'gif' || Number(item.illustType) === 2)) {
      return await this._saveGifFromNetwork(item);
    }

    const id = PixivEntity.makeId(item.illustId, item._pageIndex ?? 0);
    const entity = await this._findEntity(item.illustId, item._pageIndex ?? 0);
    // 若已有轻记录（toggleLike 创建、无文件），重建时保留其 likedAt，避免喜欢标记被抹掉
    let preserveLikedAt = 0;
    if (entity) {
      // 已有记录 → 迁移到 saved（幂等时直接返回）
      if (entity.fileName) {
        const result = await this._promoteToSaved(entity);
        if (result.success) scheduleMetaBackup();
        return result;
      }
      // 轻记录（无实际文件，如 toggleLike 创建的）：只记下 likedAt，**别删记录**。
      // 删了之后任何一步失败（no_url / download_failed / file_write_failed 都是直接 return）
      // 都会把这条喜欢永久抹掉，而内存里的红心还亮着 —— 要重启后才发现喜欢没了。
      // 保存成功时 repository.save 用同一个 key（makeId 指同一条）覆盖这条轻记录，
      // likedAt 由下面的 preserveLikedAt 带回来。
      preserveLikedAt = entity.likedAt || 0;
    }

    const cleanTitle = (item.title || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();

    // 目标文件名由 illustId/作者/标题决定：若系统相册已有同名文件 → 跳过下载，直接补元数据
    const probe = new PixivEntity({
      id,
      illustId: item.illustId,
      source: item.source || 'pixiv',
      pageIndex: item._pageIndex ?? 0,
      type: 'image',
      title: cleanTitle,
      authorName: item.authorName || item.author || '',
    });
    const probeName = this.fileStore.buildFileName(probe);
    if (await galleryHasFile(probeName)) {
      const newEntity = new PixivEntity({
        id,
        illustId: item.illustId,
        source: item.source || 'pixiv',
        pageIndex: item._pageIndex ?? 0,
        type: 'image',
        state: 'saved',
        fileName: probeName,
        title: cleanTitle,
        author: item.author || '',
        authorName: item.authorName || item.author || '',
        authorAccount: item.authorAccount || '',
        authorAvatar: item.authorAvatar || '',
        authorId: item.authorId || '',
        tags: item.tags || [],
        cachedAt: Date.now(),
        likedAt: preserveLikedAt || (item._liked ? Date.now() : 0),
        originalUrl: '',
        webUrl: item.webUrl || item.pixivUrl || '',
      });
      await this.repository.save(newEntity);
      scheduleMetaBackup();
      return { success: true, cached: true, idempotent: true, skipped: true, fileName: probeName, entity: newEntity };
    }

    // 全新记录 → 下载图片并创建 saved 实体（原图优先，失败自动降级）
    const urls = buildDownloadUrls(item);
    if (urls.length === 0) return { success: false, error: 'no_url' };
    const mon = downloadMonitor.start(`${item.illustId}_${item._pageIndex ?? 0}`, {
      illustId: item.illustId,
      page: item._pageIndex ?? 0,
      title: cleanTitle,
      kind: 'image',
      message: '下载原图',
    });
    // 失败时登记完整重试信息（供下载管理一键重试；item 里带 _silent 时是批量，仍保留）
    const failMeta = {
      illustId: item.illustId,
      source: item.source || 'pixiv',
      page: item._pageIndex ?? 0,
      type: 'image',
      illustType: item.illustType,
      originalUrl: item.originalUrl,
      mediumUrl: item.mediumUrl,
      thumbnailUrl: item.thumbnailUrl,
      title: cleanTitle,
      author: item.author || item.authorName || '',
      authorName: item.authorName || item.author || '',
      authorId: item.authorId || '',
      tags: item.tags,
      webUrl: item.webUrl || item.pixivUrl || '',
      _liked: item._liked,
    };
    mon.setProgress(0);
    let data = null;
    let usedUrl = '';
    try {
      for (const url of urls) {
        data = await this.networkStore.downloadImage(url, (info) => {
          // info = { pct, loaded, total }：字节数只有原生/桌面流式通道才给得出，
          // 拿不到时 pct 为 null，下载管理就不显示百分比（不编造）
          mon.setProgress(info?.pct ?? null, info);
        });
        if (data) { usedUrl = url; break; }
      }
      if (!data) {
        mon.recordFailure(failMeta);
        mon.finish(false, '下载失败');
        return { success: false, error: 'download_failed' };
      }
      mon.setStatus('writing', '写入相册');
      mon.setProgress(75);

      const newEntity = new PixivEntity({
        id,
        illustId: item.illustId,
        source: item.source || 'pixiv',
        pageIndex: item._pageIndex ?? 0,
        type: 'image',
        state: 'saved',
        fileName: '',
        title: cleanTitle,
        author: item.author || '',
        authorName: item.authorName || item.author || '',
        authorAccount: item.authorAccount || '',
        authorAvatar: item.authorAvatar || '',
        authorId: item.authorId || '',
        tags: item.tags || [],
        cachedAt: Date.now(),
        originalUrl: usedUrl,
        // 作品在原站的地址：booru 的详情页外链靠它，缺了就只能显示空白（喜欢轻记录是存了的）
        webUrl: item.webUrl || item.pixivUrl || '',
        likedAt: preserveLikedAt || (item._liked ? Date.now() : 0),
      });
      newEntity.fileName = this.fileStore.buildFileName(newEntity);

      const written = await this.fileStore.save(newEntity, data, 'saved');
      if (!written) {
        mon.recordFailure(failMeta);
        mon.finish(false, '写入相册失败');
        return { success: false, error: 'file_write_failed' };
      }
      await this.repository.save(newEntity);
      mon.finish(true); // → 100%
      scheduleMetaBackup();
      return { success: true, entity: newEntity };
    } catch (e) {
      mon.recordFailure(failMeta);
      mon.finish(false, e?.message || '保存失败');
      throw e;
    }
  }

  /**
   * 获取所有 entity（全量扫描，仅用于迁移/清理）。
   * @returns {Promise<PixivEntity[]>}
   */
  async getAll() {
    return await this.repository.getAll();
  }

  /**
   * 动图保存编排：下载监控 + 失败登记（供下载管理一键重试），实际取帧/编码在 _doSaveGif。
   * 并发去重由 storageFacade 完成（动图统一页 0，与静图共用 `${illustId}_0` 键）。
   * @param {object} item — 动图条目
   * @returns {Promise<{success?: boolean, error?: string, ...}>}
   */
  async _saveGifFromNetwork(item) {
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
      const r = await this._doSaveGif(item, wrapped);
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
   * 只导出系统相册（MediaStore / Pictures/PixivViewer），不写私有副本（避免双写）。
   */
  async _doSaveGif(item, onProgress) {
    const sid = String(item.illustId);
    // booru 站没有 Ugoira：只有 Pixiv 作品的 meta 接口存在，误入这里必然一路 404
    if (item.source && item.source !== 'pixiv') return { error: '该来源不支持动图' };
    const existing = await this.repository.find(PixivEntity.makeId(sid, 0));
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
      await this.repository.save(entity);
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
      await this.repository.save(entity);
      scheduleMetaBackup();

      onProgress?.(100);
      return { success: true, cached: true, fileName: gifFileName, entity };
    } catch (e) {
      log.error('[_doSaveGif] 失败:', e.message);
      return { error: `GIF 保存失败: ${e.message}` };
    }
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

/**
 * 构建可下载的图片地址候选列表（原图优先）。
 *
 * 统一转成可访问的 pixiv.re 代理地址：i.pximg.net 直连在 WebView 里会被 CORS/Referer 拦截；
 * 非 Pixiv 来源的地址保持原样。导出便于单元测试。
 *
 * @param {object} item — 含 illustId / _pageIndex / originalUrl / mediumUrl / thumbnailUrl
 * @returns {string[]}
 */
export function buildDownloadUrls(item) {
  if (!item) return [];
  // 非 Pixiv 来源：API 返回的就是可直连的图床地址，直接用作候选，绝不回退 pixivReUrl
  // （否则会拿同号的 pixiv 作品顶包，存下一张完全无关的图）。
  // dev 下 fetchableImageUrls 会把图床域名换成同源代理（图床不返回 CORS 头，直连 fetch 会被拦）。
  if (item.source && item.source !== 'pixiv') {
    const urls = fetchableImageUrls(item);
    log.debug('[buildDownloadUrls]', item.source, item.illustId, '→', urls);
    return urls;
  }
  const page = item._pageIndex ?? 0;
  const candidates = [];
  // 优先：从 API 返回的 originalUrl 推导（含日期路径，命中率高，避免短链 404）
  for (const u of [item.originalUrl, item.mediumUrl]) {
    if (!u || !item.illustId) continue;
    // 仅从含日期路径的 Pixiv URL 推导（正则匹配日期路径+illustId_pN，容忍 2026 起的 -hash 段），避免误取缩略图尺寸
    const m = u.match(/\/(\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2})\/(\d+)(?:-[0-9a-f]{32})?_p\d+/);
    if (m) {
      const datePath = m[1];
      const id = m[2];
      candidates.push(`https://i.pixiv.re/img-original/img/${datePath}/${id}_p${page}.jpg`);
    }
  }
  // 兜底：直接从 illustId 推导短链
  if (item.illustId) candidates.push(pixivReUrl(String(item.illustId), page));
  log.debug('[buildDownloadUrls] illustId:', item.illustId, 'page:', page, '→', candidates);
  return [...new Set(candidates)].filter(Boolean);
}
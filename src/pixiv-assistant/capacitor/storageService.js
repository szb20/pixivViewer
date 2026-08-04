/**
 * PixivStorageService — 业务编排层。
 *
 * 只负责编排，不执行具体操作。
 * 每行代码都应能看出「业务规则」而非「实现细节」。
 *
 * 依赖注入所有下层，便于测试。
 */
import { PixivEntity } from './entity.js';
import { PixivRepository } from './repository.js';
import { FileStore } from './fileStore.js';
import { TransitionEngine } from './transitionEngine.js';
import { NetworkStore } from './networkStore.js';
import { galleryHasFile } from './gallery.js';
import { pixivReUrl } from '../core/utils.js';
import { createLogger } from '../../utils/logger.js';
import { downloadMonitor } from '../../utils/downloadMonitor.js';
import { scheduleMetaBackup } from './metaBackup.js';

const log = createLogger('storageService');

export class PixivStorageService {
  constructor() {
    this.repository = new PixivRepository();
    this.fileStore = new FileStore();
    this.transitionEngine = new TransitionEngine(this.repository, this.fileStore);
    this.networkStore = new NetworkStore();
  }

  /**
   * 保存到相册 (cached → saved)。
   * 幂等：已是 saved 状态则直接返回。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean, entity?: PixivEntity, error?: string, idempotent?: boolean}>}
   */
  async save(illustId, pageIndex = 0) {
    const id = PixivEntity.makeId(illustId, pageIndex);

    // 1. 查找 entity
    let entity = await this.repository.find(id);
    if (!entity) {
      // 仅动图允许回退到页 0；普通图片必须逐页精确匹配
      const gifEntity = await this.repository.find(PixivEntity.makeId(illustId, 0));
      if (gifEntity?.isGif) entity = gifEntity;
    }
    if (!entity) return { success: false, error: 'not_found' };

    // 2. 委托 TransitionEngine
    const result = await this.transitionEngine.transition('cached→saved', entity);
    if (result.success) scheduleMetaBackup();
    return result;
  }

  /**
   * 移回缓存 (saved → cached)。
   * 幂等：已是 cached 状态则直接返回。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean, entity?: PixivEntity, error?: string, idempotent?: boolean}>}
   */
  async unsave(illustId, pageIndex = 0) {
    const id = PixivEntity.makeId(illustId, pageIndex);

    let entity = await this.repository.find(id);
    if (!entity) {
      // 仅动图允许跨页回退到页 0；普通图片必须页页精确匹配，
      // 否则本地复用时会把其它页的图片当成当前页显示
      const gifEntity = await this.repository.find(PixivEntity.makeId(illustId, 0));
      if (gifEntity?.isGif) entity = gifEntity;
    }
    if (!entity) return { success: false, error: 'not_found' };

    const result = await this.transitionEngine.transition('saved→cached', entity);
    if (result.success) scheduleMetaBackup();
    return result;
  }

  /**
   * 删除图片。
   * delete 就是删除 file + meta，不存在 deleted 状态。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean}>}
   */
  async delete(illustId, pageIndex = 0) {
    const id = PixivEntity.makeId(illustId, pageIndex);
    const entity = await this.repository.find(id);
    if (!entity) return { success: true }; // 已不存在

    // 删除文件
    await this.fileStore.delete(entity);
    // 删除元数据
    await this.repository.delete(entity.id);
    scheduleMetaBackup();
    return { success: true };
  }

  /**
   * 加载图片 blob URL。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{localUrl: string, data: string}|null>}
   */
  async load(illustId, pageIndex = 0) {
    const id = PixivEntity.makeId(illustId, pageIndex);
    let entity = await this.repository.find(id);
    if (!entity) {
      // 仅动图允许跨页回退到页 0；普通图片必须页页精确匹配，
      // 否则本地复用时会把其它页的图片当成当前页显示
      const gifEntity = await this.repository.find(PixivEntity.makeId(illustId, 0));
      if (gifEntity?.isGif) entity = gifEntity;
    }
    if (!entity) return null;
    return await this.fileStore.load(entity);
  }

  /**
   * 查询图片状态。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{state: 'none'|'cached'|'saved', flags: object, liked: boolean}>}
   */
  async getState(illustId, pageIndex = 0) {
    const id = PixivEntity.makeId(illustId, pageIndex);
    let entity = await this.repository.find(id);
    if (!entity) {
      const gifId = PixivEntity.makeId(illustId, 0);
      entity = await this.repository.find(gifId);
    }
    if (!entity) return { state: 'none', flags: {}, liked: false };
    return { state: entity.state, flags: entity.flags, liked: entity.isLiked };
  }

  /**
   * 查询缓存状态（兼容旧接口格式）。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{cached: boolean, saved: boolean, favorite: boolean}>}
   */
  async getCacheStatus(illustId, pageIndex = 0) {
    const { state, flags } = await this.getState(illustId, pageIndex);
    return {
      cached: state !== 'none',
      saved: state === 'saved',
      favorite: flags.favorite || false,
    };
  }

  /**
   * 按状态分页查询。
   * @param {'cached'|'saved'} state
   * @param {number} offset
   * @param {number} limit
   * @returns {Promise<{items: PixivEntity[], total: number}>}
   */
  async listByState(state, offset = 0, limit = 50) {
    return await this.repository.listByState(state, offset, limit);
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
   * 统计信息。
   * @returns {Promise<{total: number, saved: number, auto: number, totalSize: number}>}
   */
  async stats() {
    return await this.repository.stats();
  }

  /**
   * 切换喜欢状态。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean, liked: boolean, likedAt: number}>}
   */
  async toggleLike(illustId, pageIndex = 0, meta = {}) {
    const id = PixivEntity.makeId(illustId, pageIndex);
    const result = await this.repository.toggleLike(id, meta);
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
    // 动图统一由 api/index.js 的 saveItem 分发到 saveGifToAlbum，本层只处理静态图

    const id = PixivEntity.makeId(item.illustId, item._pageIndex ?? 0);
    let entity = await this.repository.find(id);
    if (!entity) {
      // 仅动图允许回退到页 0（动图统一存页 0）；普通图片必须逐页独立保存，
      // 否则多图作品只存了页 0 时，保存其它页会被误判为"已存在"而跳过下载
      const gifEntity = await this.repository.find(PixivEntity.makeId(item.illustId, 0));
      if (gifEntity?.isGif) entity = gifEntity;
    }
    if (entity) {
      // 已有记录 → 迁移到 saved（幂等时直接返回）
      // 轻记录（无实际文件，如 toggleLike 创建的）→ 删掉重新下载
      if (!entity.fileName) {
        await this.repository.delete(entity.id);
      } else {
        const result = await this.transitionEngine.transition('cached→saved', entity);
        if (result.success) scheduleMetaBackup();
        return result;
      }
    }

    const cleanTitle = (item.title || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();

    // 目标文件名由 illustId/作者/标题决定：若系统相册已有同名文件 → 跳过下载，直接补元数据
    const probe = new PixivEntity({
      id,
      illustId: item.illustId,
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
        pageIndex: item._pageIndex ?? 0,
        type: 'image',
        state: 'saved',
        fileName: probeName,
        title: cleanTitle,
        author: item.author || '',
        authorName: item.authorName || item.author || '',
        authorAccount: item.authorAccount || '',
        authorId: item.authorId || '',
        tags: item.tags || [],
        cachedAt: Date.now(),
        likedAt: item._liked ? Date.now() : 0,
        originalUrl: '',
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
    // 真实字节进度拿不到（CapacitorHttp 无进度事件、i.pixiv.re 无 CORS 无法流式读取），
    // 用阶段估算：下载中 5→55% 缓速前进，写入相册 75%，完成 100%
    mon.setProgress(5);
    let ramp = 5;
    let gotRealProgress = false;
    const rampTimer = setInterval(() => {
      if (gotRealProgress) { clearInterval(rampTimer); return; }
      ramp = Math.min(55, ramp + 4);
      mon.setProgress(ramp);
      if (ramp >= 55) clearInterval(rampTimer);
    }, 600);
    let data = null;
    let usedUrl = '';
    try {
      for (const url of urls) {
        data = await this.networkStore.downloadImage(url, (pct) => {
          gotRealProgress = true;
          mon.setProgress(pct);
        });
        if (data) { usedUrl = url; break; }
      }
      if (!data) {
        clearInterval(rampTimer);
        mon.finish(false, '下载失败');
        return { success: false, error: 'download_failed' };
      }
      clearInterval(rampTimer);
      mon.setStatus('writing', '写入相册');
      mon.setProgress(75);

      const newEntity = new PixivEntity({
        id,
        illustId: item.illustId,
        pageIndex: item._pageIndex ?? 0,
        type: 'image',
        state: 'saved',
        fileName: '',
        title: cleanTitle,
        author: item.author || '',
        authorName: item.authorName || item.author || '',
        authorAccount: item.authorAccount || '',
        authorId: item.authorId || '',
        tags: item.tags || [],
        cachedAt: Date.now(),
        likedAt: item._liked ? Date.now() : 0,
        originalUrl: usedUrl,
      });
      newEntity.fileName = this.fileStore.buildFileName(newEntity);

      const written = await this.fileStore.save(newEntity, data, 'saved');
      if (!written) {
        mon.finish(false, '写入相册失败');
        return { success: false, error: 'file_write_failed' };
      }
      await this.repository.save(newEntity);
      mon.finish(true); // → 100%
      scheduleMetaBackup();
      return { success: true, entity: newEntity };
    } catch (e) {
      clearInterval(rampTimer);
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
  const page = item._pageIndex ?? 0;
  const candidates = [];
  // 优先：从 API 返回的 originalUrl 推导（含日期路径，命中率高，避免短链 404）
  for (const u of [item.originalUrl, item.mediumUrl]) {
    if (!u || !item.illustId) continue;
    // 仅从含日期路径的 Pixiv URL 推导（正则匹配日期路径+illustId_pN），避免误取缩略图尺寸
    const m = u.match(/\/(\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2})\/(\d+)_p\d+/);
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

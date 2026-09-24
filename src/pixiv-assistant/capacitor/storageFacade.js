/**
 * StorageFacade — UI 门面。
 *
 * 职责：参数校验、错误转换、并发去重。
 * 不再混入 Toast —— 提示由 UI 层根据返回值自行决定。
 */
import { PixivStorageService } from './storageService.js';

export class StorageFacade {
  constructor() {
    this.service = new PixivStorageService();
    // 进行中的保存请求（按 作品ID_页码 去重），避免并发重复下载/重复提示
    this._saveInFlight = new Map();
  }

  /**
   * 下载并保存到相册（原图优先）——UI 层「保存」的入口。
   * @param {object} item — 图片条目（含 illustId / _pageIndex / originalUrl / mediumUrl / title 等）
   * @returns {Promise<{success: boolean, entity?: import('./entity.js').PixivEntity, error?: string, idempotent?: boolean}>}
   */
  async saveFromNetwork(item) {
    if (!item?.illustId) return { success: false, error: 'invalid_item' };
    // 同一张图并发保存（自动保存 + 点♡等）共享同一个 promise：只下载一次
    const id = `${item.illustId}_${item._pageIndex ?? 0}`;
    const inFlight = this._saveInFlight.get(id);
    if (inFlight) return inFlight;
    const promise = this._doSaveFromNetwork(item);
    this._saveInFlight.set(id, promise);
    promise.finally(() => this._saveInFlight.delete(id)).catch(() => { });
    return promise;
  }

  async _doSaveFromNetwork(item) {
    return await this.service.saveFromNetwork(item);
  }

  /**
   * 加载图片 blob URL。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{localUrl: string}|null>}
   */
  async load(illustId, pageIndex = 0) {
    if (!illustId) return null;
    return await this.service.load(illustId, pageIndex);
  }

  /**
   * 按喜欢状态分页查询。
   * @param {number} offset
   * @param {number} limit
   * @returns {Promise<{items: import('./entity.js').PixivEntity[], total: number}>}
   */
  async listLiked(offset = 0, limit = 50) {
    return await this.service.listLiked(offset, limit);
  }

  /**
   * 切换喜欢状态（可携带展示元数据，供「喜欢」页展示缩略图/标题）。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @param {object} [meta]
   */
  async toggleLike(illustId, pageIndex = 0, meta = {}) {
    if (!illustId) return { success: false, liked: false, likedAt: 0 };
    return await this.service.toggleLike(illustId, pageIndex, meta);
  }

  /**
   * 幂等设为喜欢。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @param {object} [meta]
   */
  async like(illustId, pageIndex = 0, meta = {}) {
    if (!illustId) return { success: false, liked: false, likedAt: 0 };
    return await this.service.like(illustId, pageIndex, meta);
  }

  /**
   * 幂等取消喜欢。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   */
  async unlike(illustId, pageIndex = 0) {
    if (!illustId) return { success: false, unliked: false, likedAt: 0 };
    return await this.service.unlike(illustId, pageIndex);
  }

  /**
   * 回填展示元数据（浏览时把完整缩略图 URL / 标题 / 作者 / tags 写回已保存/喜欢的记录）。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @param {object} meta
   * @returns {Promise<{updated: boolean}>}
   */
  async fillMeta(illustId, pageIndex = 0, meta = {}) {
    if (!illustId) return { updated: false };
    return await this.service.fillMeta(illustId, pageIndex, meta);
  }

  /**
   * 回填缺失的展示元数据（缩略图/标题/作者等），供「喜欢」页网格展示。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @param {object} [meta]
   * @returns {Promise<{updated: boolean}>}
   */
  async backfillMeta(illustId, pageIndex = 0, meta = {}) {
    if (!illustId) return { updated: false };
    return await this.service.backfillMeta(illustId, pageIndex, meta);
  }

  /**
   * 获取所有 entity（全量扫描，仅用于迁移/清理）。
   * @returns {Promise<import('./entity.js').PixivEntity[]>}
   */
  async getAll() {
    return await this.service.getAll();
  }
}

/** 单例 */
export const storageFacade = new StorageFacade();
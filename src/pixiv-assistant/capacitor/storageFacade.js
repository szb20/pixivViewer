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
   * 保存到相册。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean, idempotent?: boolean, error?: string}>}
   */
  async save(illustId, pageIndex = 0) {
    if (!illustId) return { success: false, error: 'invalid_item' };
    return await this.service.save(illustId, pageIndex);
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
    promise.finally(() => this._saveInFlight.delete(id)).catch(() => {});
    return promise;
  }

  async _doSaveFromNetwork(item) {
    return await this.service.saveFromNetwork(item);
  }

  /**
   * 移回缓存。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean, idempotent?: boolean, error?: string}>}
   */
  async unsave(illustId, pageIndex = 0) {
    if (!illustId) return { success: false, error: 'invalid_item' };
    return await this.service.unsave(illustId, pageIndex);
  }

  /**
   * 删除图片。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean}>}
   */
  async delete(illustId, pageIndex = 0) {
    if (!illustId) return { success: false };
    return await this.service.delete(illustId, pageIndex);
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
   * 查询图片状态。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{state: string, flags: object, liked: boolean}>}
   */
  async getState(illustId, pageIndex = 0) {
    if (!illustId) return { state: 'none', flags: {}, liked: false };
    return await this.service.getState(illustId, pageIndex);
  }

  /**
   * 获取缓存状态（兼容旧接口：返回 { cached, saved }）。
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
   * @returns {Promise<{items: import('./entity.js').PixivEntity[], total: number}>}
   */
  async listByState(state, offset = 0, limit = 50) {
    return await this.service.listByState(state, offset, limit);
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

/**
 * StorageFacade — UI 门面。
 *
 * 给 UI 组件调用的最外层。
 * 职责：参数校验、错误转换、Toast 提示。
 *
 * 当前先保留 Toast，后续再改为抛 StorageError 由 UI 层 catch。
 */
import { PixivStorageService } from './storageService.js';
import { showToast } from '../../../src/utils/toast.js';

export class StorageFacade {
  constructor() {
    this.service = new PixivStorageService();
    // 进行中的保存请求（按 作品ID_页码 去重），避免并发重复下载/重复 toast
    this._saveInFlight = new Map();
  }

  /**
   * 保存到相册。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean, idempotent?: boolean, error?: string}>}
   */
  async save(illustId, pageIndex = 0) {
    if (!illustId) {
      showToast('无法识别作品 ID', { type: 'error' });
      return { success: false };
    }
    const result = await this.service.save(illustId, pageIndex);
    if (result.idempotent) {
      showToast('已在相册中');
    } else if (result.success) {
      showToast('已保存到相册');
    } else {
      showToast(this._errorMessage(result.error), { type: 'error' });
    }
    return result;
  }

  /**
   * 下载并保存到相册（原图优先）— UI 层「保存」的唯一入口。
   * @param {object} item — 图片条目（含 illustId / _pageIndex / originalUrl / mediumUrl / title 等）
   * @returns {Promise<{success: boolean, entity?: import('./entity.js').PixivEntity, error?: string, idempotent?: boolean}>}
   */
  async saveFromNetwork(item) {
    if (!item?.illustId) {
      if (!item?._silent) showToast('无法识别作品 ID', { type: 'error' });
      return { success: false };
    }
    // 同一张图并发保存（自动保存 + 点♥等）共享同一个 promise：只下载一次、只弹一次 toast
    const id = `${item.illustId}_${item._pageIndex ?? 0}`;
    const inFlight = this._saveInFlight.get(id);
    if (inFlight) return inFlight;
    const promise = this._doSaveFromNetwork(item);
    this._saveInFlight.set(id, promise);
    promise.finally(() => this._saveInFlight.delete(id)).catch(() => {});
    return promise;
  }

  async _doSaveFromNetwork(item) {
    const result = await this.service.saveFromNetwork(item);
    // 静默模式（点♥后台批量保存 / 自动保存重复触发）不弹 toast
    if (item._silent) return result;
    if (result.idempotent) {
      showToast('已在相册中');
    } else if (result.success) {
      showToast('已保存到相册');
    } else if (result.error !== 'gif_not_supported') {
      showToast(this._errorMessage(result.error), { type: 'error' });
    }
    return result;
  }

  /**
   * 移回缓存。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean, idempotent?: boolean, error?: string}>}
   */
  async unsave(illustId, pageIndex = 0) {
    if (!illustId) {
      showToast('无法识别作品 ID', { type: 'error' });
      return { success: false };
    }
    const result = await this.service.unsave(illustId, pageIndex);
    if (result.idempotent) {
      showToast('已在缓存中');
    } else if (result.success) {
      showToast('已移回缓存');
    } else {
      showToast(this._errorMessage(result.error), { type: 'error' });
    }
    return result;
  }

  /**
   * 删除图片。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean}>}
   */
  async delete(illustId, pageIndex = 0) {
    if (!illustId) return { success: false };
    const result = await this.service.delete(illustId, pageIndex);
    if (result.success) {
      showToast('已删除');
    }
    return result;
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
   * 切换喜欢状态。
   * @param {string} illustId
   * @param {number} [pageIndex=0]
   * @returns {Promise<{success: boolean, liked: boolean, likedAt: number}>}
   */
  async toggleLike(illustId, pageIndex = 0) {
    if (!illustId) {
      showToast('无法识别作品 ID', { type: 'error' });
      return { success: false, liked: false, likedAt: 0 };
    }
    const result = await this.service.toggleLike(illustId, pageIndex);
    if (result.success) {
      showToast(result.liked ? '❤️ 已喜欢' : '已取消喜欢');
    } else {
      showToast('操作失败', { type: 'error' });
    }
    return result;
  }

  /**
   * 获取所有 entity（全量扫描，仅用于迁移/清理）。
   * @returns {Promise<import('./entity.js').PixivEntity[]>}
   */
  async getAll() {
    return await this.service.getAll();
  }

  _errorMessage(code) {
    const map = {
      'not_found': '未找到缓存',
      'file_copy_failed': '文件操作失败',
      'invalid_state': '状态异常，请刷新后重试',
      'no_url': '缺少图片地址',
      'download_failed': '图片下载失败',
      'file_write_failed': '文件写入失败',
      'invalid_item': '无法识别作品',
    };
    if (code?.startsWith('invalid_state:')) {
      return '状态异常，请刷新后重试';
    }
    return map[code] || '操作失败，请重试';
  }
}

/** 单例 */
export const storageFacade = new StorageFacade();

/**
 * Pixiv Capacitor 模块 — 统一导出入口。
 * 存储层（IndexedDB 元数据 + 文件系统相册）+ tab 结果缓存。
 */
export {
  getMeta, putMeta, putMetaBatch, deleteMeta, getAllMeta,
  getByStatePaginated, getLikedMetaPaginated, getByIllustId, searchByTag,
  getCacheStats as getDBCacheStats,
} from './cacheDB.js';
export { PixivEntity } from './entity.js';
export { PixivRepository } from './repository.js';
export { FileStore } from './fileStore.js';
export { TransitionEngine } from './transitionEngine.js';
export { PixivStorageService } from './storageService.js';
export { NetworkStore } from './networkStore.js';
export { storageFacade, StorageFacade } from './storageFacade.js';
export { saveTabCache, loadTabCache, loadAllTabCaches, deleteTabCache } from './tabCache.js';

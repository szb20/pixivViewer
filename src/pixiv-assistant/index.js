/**
 * Pixiv Assistant — 模块统一导出入口（本包对外的唯一公共 API）。
 * 核心 API 工厂 + 存储层（相册/缓存）+ 工具函数。
 *
 * 仅导出实际被消费的符号，避免死导出增加打包体积。
 * 包外代码一律从本文件 import —— .oxlintrc.json 的 no-restricted-imports
 * 禁止跨包深路径（core/ capacitor/）引用；包内模块间引用不受此约束。
 */
export {
  getCompositeKey, qualifyId, sourceOfId, rawIdOf, DEFAULT_SOURCE,
  pixivReUrl, pixivPageUrl, buildGifFileName,
} from './core/utils.js';
export { CACHE_DIR } from './core/constants.js';
export { createPixivApi } from './core/pixivApi.js';

export { getSettings, getSettingsSync, saveSettings, getFS, getPixivCookie, configurePixiv } from './capacitor/config.js';
export { PixivEntity } from './capacitor/entity.js';
export { PixivRepository } from './capacitor/repository.js';
export { storageFacade } from './capacitor/storageFacade.js';
export { saveTabCache, loadTabCache, scopedTabKey } from './capacitor/tabCache.js';
export { getMeta, putMeta } from './capacitor/cacheDB.js';
export { galleryHasFile, exportToGallery, isGalleryAvailable, ensureGalleryReadPermission } from './capacitor/gallery.js';
export {
  scheduleMetaBackup, restoreMetaBackupIfNeeded, ensureMetaBackup, reconcileGallery,
  isMetaBackupAvailable, hasAllFilesAccess, requestAllFilesAccess, cleanupLegacyMetaPngs,
  backupNow, restoreNow,
} from './capacitor/metaBackup.js';

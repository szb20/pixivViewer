/**
 * Pixiv Viewer — 模块统一导出入口。
 * 核心 API 工厂 + 存储层（相册/缓存）+ 工具函数。
 */
export {
  pixivReUrl, proxyThumb, pixivPageUrl, pixivOriginalUrl,
  extractUserIdFromCookie, getCompositeKey, safeFileName,
  parseCacheFileName, getCacheKey,
} from './core/utils.js';
export { PIXIV_BASE, PIXIV_RE, PIXIV_CACHE_TTL, RANKING_MODES, RANKING_MODE_NAMES, CACHE_DIR } from './core/constants.js';
export { createPixivApi } from './core/pixivApi.js';

export { configurePixiv, getSettings, getSettingsSync, saveSettings, getFS } from './capacitor/config.js';
export { PixivEntity } from './capacitor/entity.js';
export { PixivRepository } from './capacitor/repository.js';
export { FileStore } from './capacitor/fileStore.js';
export { ensureDirectory } from './capacitor/fileStore.js';
export { TransitionEngine } from './capacitor/transitionEngine.js';
export { PixivStorageService } from './capacitor/storageService.js';
export { NetworkStore } from './capacitor/networkStore.js';
export { storageFacade, StorageFacade } from './capacitor/storageFacade.js';
export { saveTabCache, loadTabCache, loadAllTabCaches, deleteTabCache } from './capacitor/tabCache.js';

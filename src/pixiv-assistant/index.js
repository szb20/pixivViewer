/**
 * Pixiv Viewer — 模块统一导出入口。
 * 核心 API 工厂 + 存储层（相册/缓存）+ 工具函数。
 * 仅导出实际被消费的符号，避免死导出增加打包体积。
 */
export {
  getCompositeKey, safeFileName, truncateUtf8Bytes, utf8ByteLen,
  qualifyId, sourceOfId, rawIdOf, DEFAULT_SOURCE, KNOWN_SOURCES,
} from './core/utils.js';
export { CACHE_DIR } from './core/constants.js';
export { createPixivApi } from './core/pixivApi.js';

export { getSettings, getSettingsSync, saveSettings, getFS } from './capacitor/config.js';
export { PixivEntity } from './capacitor/entity.js';
export { PixivRepository } from './capacitor/repository.js';
export { storageFacade } from './capacitor/storageFacade.js';
export { saveTabCache, loadTabCache, scopedTabKey } from './capacitor/tabCache.js';
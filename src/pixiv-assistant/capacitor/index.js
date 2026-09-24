/**
 * Pixiv Capacitor 模块 — 统一导出入口。
 * 存储层（IndexedDB 元数据 + 文件系统相册）+ tab 结果缓存。
 * 注意：当前无外部消费方（顶层 barrel 直接从各模块导入）；
 * 保留此文件作为 capacitor 子包的公共出口，仅导出稳定 API。
 */
export { PixivEntity } from './entity.js';
export { PixivRepository } from './repository.js';
export { storageFacade } from './storageFacade.js';
export { saveTabCache, loadTabCache } from './tabCache.js';
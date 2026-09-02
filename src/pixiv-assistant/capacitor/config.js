/**
 * Pixiv 模块配置 — 支持依赖注入，与宿主应用解耦。
 *
 * 允许主应用注入 settings 和 storage 适配器（configurePixiv），
 * 未注入时使用内置默认实现：
 * - getSettings: localStorage（pixiv_viewer_settings），支持 VITE_PIXIV_COOKIE 环境变量
 * - getFS: Capacitor Filesystem（原生环境），非原生环境返回 null
 */
import { appStorage, migrateFromLegacyKey } from '../../utils/appStorage.js';
import { isDesktop } from '../../utils/platform.js';

let _getSettings = null;
let _getFS = null;

// 迁移旧版独立 settings key → 统一 key
migrateFromLegacyKey('pixiv_viewer_settings', 'settings');

/**
 * 配置 Pixiv 模块的适配器。
 * @param {Object} opts
 * @param {Function} [opts.getSettings] - 返回 settings 对象的异步函数
 * @param {Function} [opts.getFS] - 返回 Capacitor Filesystem 对象的异步函数
 */
export function configurePixiv(opts = {}) {
  if (opts.getSettings) _getSettings = opts.getSettings;
  if (opts.getFS) _getFS = opts.getFS;
}

/** 同步读取设置（渲染期可用；合并默认值） */
export function getSettingsSync() {
  const stored = appStorage.get('settings', {}) || {};
  return {
    ...stored,
    proxyUrl: stored.proxyUrl || 'http://127.0.0.1:7890',
    pixivCookie: stored.pixivCookie || import.meta.env.VITE_PIXIV_COOKIE || '',
    gridQuality: stored.gridQuality || 'thumb',       // 'mini' | 'thumb'
    detailQuality: stored.detailQuality || 'original', // 'regular' | 'original'
  };
}

async function defaultGetSettings() {
  return getSettingsSync();
}

let _fsCache = null;

async function defaultGetFS() {
  if (_fsCache !== null) return _fsCache;
  // 桌面端（Electron）：桌面 FS 适配器（接口与 Capacitor Filesystem 一致，底层走 Node fs）
  if (isDesktop) {
    try {
      const { createDesktopFilesystem } = await import('../../utils/desktopFs.js');
      _fsCache = { plugin: createDesktopFilesystem() };
    } catch {
      _fsCache = null;
    }
    return _fsCache;
  }
  const isNative = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
  if (!isNative) {
    _fsCache = null;
    return null;
  }
  try {
    const { Filesystem } = await import('@capacitor/filesystem');
    _fsCache = { plugin: Filesystem };
  } catch {
    _fsCache = null;
  }
  return _fsCache;
}

/**
 * 获取 settings 对象。
 * 已通过 configurePixiv 注入则使用注入版本，否则使用默认实现。
 */
export async function getSettings() {
  if (_getSettings) return _getSettings();
  return defaultGetSettings();
}

/** 保存 settings（localStorage）。 */
export async function saveSettings(s) {
  appStorage.set('settings', s);
}

/**
 * 获取 Capacitor Filesystem 对象（{ plugin } 形态）。
 * 已通过 configurePixiv 注入则使用注入版本，否则使用默认实现。
 */
export async function getFS() {
  if (_getFS) return _getFS();
  try {
    return await defaultGetFS();
  } catch {
    return null;
  }
}
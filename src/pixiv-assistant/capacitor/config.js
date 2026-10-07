/**
 * Pixiv 模块配置 — 支持依赖注入，与宿主应用解耦。
 *
 * 允许主应用注入 settings 和 storage 适配器（configurePixiv），
 * 未注入时使用内置默认实现：
 * - getSettings: localStorage（pixiv_viewer_settings）
 * - getFS: Capacitor Filesystem（原生环境），非原生环境返回 null
 */
import { appStorage, migrateFromLegacyKey } from '../../utils/appStorage.js';
import { DEFAULT_SOURCE } from '../core/utils.js';

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

// ⚠️ 【测试期临时】构建期注入 Cookie —— 发版前必须整段删除（连同下面的 buildCookie 引用）。
// Vite 会把值静态内联进产物，APK / Electron 包反编译即可拿到 PHPSESSID，属于已知取舍。
// - DEV（vite dev server / 桌面端调试）：读 VITE_PIXIV_COOKIE，生产构建时该分支被静态剔除。
// - 测试包（生产构建）：显式读 VITE_DEV_COOKIE —— 不设这个变量，注入即自动失效，
//   所以「发版」只需删掉这一行，无需改别处。
// 设置页手填的值优先级更高（用户改过一次就覆盖内置值）；点「清空」可恢复内置值。
const buildCookie = import.meta.env.DEV
  ? (import.meta.env.VITE_PIXIV_COOKIE || '')
  : (import.meta.env.VITE_DEV_COOKIE || '');

/** 同步读取设置（渲染期可用；合并默认值） */
export function getSettingsSync() {
  const stored = appStorage.get('settings', {}) || {};
  return {
    ...stored,
    proxyUrl: stored.proxyUrl || 'http://127.0.0.1:7890',
    pixivCookie: stored.pixivCookie || buildCookie,
    gridLayout: stored.gridLayout || 'waterfall',      // 内容页布局：'waterfall'（瀑布流）| 'grid'（方形宫格）
    saveDirectory: stored.saveDirectory || '',         // 桌面端图片保存目录（空 = 系统图片文件夹）
    // 桌面端：指定了目录后是否仍每次弹「另存为」。默认 false = 直接存进上面的目录
    // （下载器的常规做法：设一次路径，之后不再打断）。未指定目录时不论此值都会弹框。
    saveAskEachTime: stored.saveAskEachTime === true,
    // 当前图片来源。老数据没有这个字段 → 落回 pixiv，行为与升级前完全一致。
    imageSource: stored.imageSource || DEFAULT_SOURCE,
    // 非 Pixiv 来源是否只显示 rating:safe。默认 false（全部显示），用户在设置页可收紧。
    booruSafeOnly: stored.booruSafeOnly === true,
  };
}

async function defaultGetSettings() {
  return getSettingsSync();
}

let _fsCache = null;

async function defaultGetFS() {
  if (_fsCache !== null) return _fsCache;
  // 仅 Capacitor 原生环境提供 Filesystem；桌面端不走本路径（桌面导出/下载走 desktopProxy 通道）
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

/**
 * 当前 PHPSESSID（容错用户把整串 `PHPSESSID=xxx` 粘进设置框的情况；空串=未配置）。
 * api/pixiv.js（API 装配）与 api/ugoira/meta.js（动图元数据）共用。
 */
export async function getPixivCookie() {
  const s = await getSettings();
  return String(s.pixivCookie || '').trim().replace(/^PHPSESSID=/i, '');
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
/**
 * 平台检测与原生能力访问统一入口。
 *
 * 三种运行环境：
 * - web：普通浏览器 / Vite dev server
 * - android：Capacitor 原生壳（window.Capacitor.isNativePlatform() === true）
 * - electron：桌面端壳（preload 注入 window.desktop 桥）
 *
 * 其余代码一律通过这里判断平台 / 取原生桥，不要散落 window.Capacitor 判断。
 */

/** 桌面端（Electron）preload 注入的桥；非桌面环境为 null */
export const desktop =
    typeof window !== 'undefined' && window.desktop && window.desktop.platform === 'electron'
        ? window.desktop
        : null;

export const isDesktop = !!desktop;

/**
 * 是否运行在 Capacitor 原生壳（Android）。
 * Electron 桌面壳不算 Capacitor 原生（状态栏 / 返回键等移动端能力应跳过）。
 */
export function isNativePlatform() {
    if (isDesktop) return false;
    return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
}

/**
 * 获取「保存到系统相册」能力的实现。
 * - Android：Capacitor GallerySaver 原生插件（MediaStore）
 * - Electron：desktop.gallery 桥（写入 图片/PixivViewer）
 * - 浏览器：null（导出不可用）
 */
export function getGallerySaver() {
    if (isDesktop) return desktop.gallery || null;
    if (typeof window !== 'undefined') return window.Capacitor?.Plugins?.GallerySaver || null;
    return null;
}
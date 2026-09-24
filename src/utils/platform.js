/**
 * 平台检测与原生能力访问统一入口。
 *
 * 三种运行环境：
 * - web：普通浏览器 / Vite dev server
 * - android：Capacitor 原生壳（window.Capacitor.isNativePlatform() === true）
 * - electron：桌面端壳（preload 注入 window.desktopProxy 桥）
 *
 * 其余代码一律通过这里判断平台 / 取原生桥，不要散落 window.Capacitor / window.desktopProxy 判断。
 */

/**
 * 桌面壳：electron/preload.cjs 注入的 window.desktopProxy。
 * 历史注：早期设计的 window.desktop 桥从未实现，桌面能力一律走 desktopProxy。
 */
export function isDesktopShell() {
    return typeof window !== 'undefined' && !!window.desktopProxy;
}

let _proxyPortPromise = null;
/**
 * 懒加载壳内代理端口（一次性获取并缓存；拿不到返回 0）。
 * 代理服务由 Electron main 进程内嵌（/pixiv-api、/pixiv-zip 等通道）。
 */
export function getDesktopProxyPort() {
    if (typeof window === 'undefined' || !window.desktopProxy) return Promise.resolve(0);
    if (!_proxyPortPromise) {
        _proxyPortPromise = window.desktopProxy.getPort().catch(() => {
            _proxyPortPromise = null; // 允许下次重试
            return 0;
        });
    }
    return _proxyPortPromise;
}

/**
 * 获取「保存到系统相册」能力的实现（Android GallerySaver 原生插件，MediaStore）。
 * - Android：GallerySaver 插件实例
 * - Electron 桌面：null（相册导出走 gallery.js 的 desktopProxy.saveFile 分支）
 * - 浏览器：null（导出不可用）
 */
export function getGallerySaver() {
    if (isDesktopShell()) return null;
    if (typeof window !== 'undefined') return window.Capacitor?.Plugins?.GallerySaver || null;
    return null;
}
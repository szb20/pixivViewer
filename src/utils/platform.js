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
 * 历史注：另有 window.desktop 桥（platform + download，流式下载用），
 * 早期还设想过 desktop.fs 文件桥但从未实现，桌面文件/目录能力一律走 desktopProxy。
 */
export function isDesktopShell() {
    return getDesktopProxy() !== null;
}

/** Android 原生壳（Capacitor） */
export function isNative() {
    return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
}

/** dev 构建（import.meta.env.DEV 的唯一出口，不要在别处重复声明 IS_DEV）。
 *  import.meta.env 是 Vite 注入的，Node 脚本（如 check:sources）经 barrel 间接触达这里时为
 *  undefined —— 用 ?. 兜成 false（Node 下本来就不是 dev），别让整条导入链崩掉。 */
export function isDev() {
    return !!import.meta.env?.DEV;
}

/** Electron preload 注入的桌面桥；非桌面环境返回 null */
export function getDesktopProxy() {
    return (typeof window !== 'undefined' && window.desktopProxy) || null;
}

/** Capacitor 全局对象；web / 非原生环境返回 null */
export function getCapacitor() {
    return (typeof window !== 'undefined' && window.Capacitor) || null;
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
    return getCapacitor()?.Plugins?.GallerySaver || null;
}
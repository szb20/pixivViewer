/**
 * 桌面端流式下载 —— 经 Electron 主进程 Node HTTP 下载（带 Clash 代理），
 * 绕开渲染进程 CORS，并回传真实字节进度。与安卓 nativeDownload 对等。
 *
 * 历史注：依赖的 window.desktop.download 桥从未在 preload 中实现（实际桥是
 * window.desktopProxy，下载走 /pixiv-zip 等代理通道），本模块当前无消费方；
 * 保留作为未来桌面下载通道的参考实现。
 */

/** 旧版 window.desktop 桥（从未实现；保留检测以兼容未来可能的同形桥） */
const desktop =
    typeof window !== 'undefined' && window.desktop && window.desktop.platform === 'electron'
        ? window.desktop
        : null;

export function isDesktopDownloadAvailable() {
    return !!desktop?.download;
}

/**
 * 桌面下载图片，返回 base64。
 * @param {string} url — 完整图片 URL
 * @param {function} [onProgress] — (pct: 0-100) => void
 * @returns {Promise<string>} base64 数据
 */
export async function desktopDownload(url, onProgress) {
    const id = `${url}_${Date.now()}`;
    let lastUiAt = 0;
    const handle = (data) => {
        if (data?.id === id && typeof data.progress === 'number') {
            const now = Date.now();
            if (now - lastUiAt >= 80 || data.progress >= 100) {
                lastUiAt = now;
                onProgress?.(data.progress);
            }
        }
    };
    desktop.download.onProgress(handle);
    try {
        const ret = await desktop.download.image({ id, url, referer: 'https://www.pixiv.net/' });
        if (ret?.data) return ret.data;
        throw new Error('下载无数据');
    } finally {
        desktop.download.offProgress(handle);
    }
}
/**
 * 桌面端流式下载 —— 经 Electron 主进程 Node HTTP 下载（带 Clash 代理），
 * 绕开渲染进程 CORS，并回传真实字节进度。与安卓 nativeDownload 对等。
 */
import { desktop } from './platform.js';

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
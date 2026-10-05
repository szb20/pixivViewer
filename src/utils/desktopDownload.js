/**
 * 桌面端流式下载 —— 经 Electron 主进程 Node HTTPS 下载（走 Clash 代理），
 * 绕开渲染进程的 CORS 限制，并回传**真实字节进度**。与安卓 nativeDownload 对等。
 *
 * 桥由 electron/preload.cjs 注入为 window.desktop.download：
 *   image(payload)      → Promise<{ id, data(base64), size }>
 *   onProgress(cb)      → 订阅 'download:progress'
 *   offProgress(cb)     → 退订
 *
 * 历史注：早期设计的 window.desktop 桥一直没实现，本模块当时无消费方；
 * 现在主进程的 download:image 通道补齐了，networkStore.downloadImage 会优先走它。
 */

/** 桌面桥（preload 注入；浏览器与安卓下为 null） */
const desktop =
    typeof window !== 'undefined' && window.desktop?.platform === 'electron'
        ? window.desktop
        : null;

export function isDesktopDownloadAvailable() {
    return !!desktop?.download;
}

/**
 * 桌面下载图片，返回 base64。
 * @param {string} url — 完整图片 URL
 * @param {function} [onProgress] — ({pct, loaded, total}) => void
 *        loaded/total 为真实字节数，主进程从 Content-Length 与已收字节得到。
 *        total 为 0 表示上游没给 Content-Length，此时 pct 为 null，只有 loaded。
 * @returns {Promise<string>} base64 数据
 */
export async function desktopDownload(url, onProgress) {
    const id = `${url}_${Date.now()}`;
    let lastUiAt = 0;
    const handle = (data) => {
        if (data?.id !== id) return;
        const now = Date.now();
        if (now - lastUiAt < 80 && data.progress !== 100) return;
        lastUiAt = now;
        onProgress?.({ pct: data.progress ?? null, loaded: data.loaded, total: data.total });
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

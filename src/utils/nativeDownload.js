/**
 * nativeDownload — 原生流式下载（Android StreamingDownload 插件）。
 *
 * 绕开 WebView 对 i.pixiv.re 的 CORS 限制（fetch/XHR 跨域读不到字节），
 * 由原生 HttpURLConnection 下载并实时上报字节进度。
 */
import { registerPlugin } from '@capacitor/core';

const StreamingDownload = registerPlugin('StreamingDownload');

export function isNativeDownloadAvailable() {
  return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
}

/**
 * 按目标域名给 Referer：只有 Pixiv 图床需要，booru 图床不校验。
 * 传空字符串即不设置该请求头（原生侧读取时以空串为准）。
 */
function refererFor(url) {
  return /pximg\.net|pixiv\.re/i.test(url || '') ? 'https://www.pixiv.net/' : '';
}

/**
 * 原生流式下载图片，返回 base64。
 * @param {string} url — 完整图片 URL
 * @param {function} [onProgress] — ({pct, loaded, total}) => void
 *        loaded/total 是真实字节数（原生侧上报），下载管理用它显示大小与速度。
 *        total 归一化为 0 表示上游没给 Content-Length（原生 `getContentLengthLong()`
 *        在无该响应头时返回 -1，这里统一成 0，避免下游要同时判 -1 和 0）。
 * @returns {Promise<string>} base64 数据
 */
export async function nativeDownload(url, onProgress) {
  const id = `${url}_${Date.now()}`;
  // 先注册进度监听，再发起下载，避免错过早期进度（否则会先走估算 ramp 再跳变）
  let lastUiAt = 0;
  const handle = await StreamingDownload.addListener('onProgress', (info) => {
    if (info?.id === id && typeof info.progress === 'number') {
      // 节流：最快每 80ms 更新一次 UI，避免快速下载时进度跳动
      const now = Date.now();
      if (now - lastUiAt >= 80 || info.progress >= 100) {
        lastUiAt = now;
        onProgress?.({
          pct: info.progress,
          loaded: info.loaded,
          total: info.total > 0 ? info.total : 0,
        });
      }
    }
  });
  try {
    const ret = await StreamingDownload.download({ url, id, referer: refererFor(url) });
    if (ret?.data) return ret.data;
    throw new Error('下载无数据');
  } finally {
    handle.remove();
  }
}

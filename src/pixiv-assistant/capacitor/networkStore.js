/**
 * NetworkStore — 网络下载层。
 *
 * 只负责从 Pixiv 下载数据，不关心存储、不关心元数据。
 *
 * 支持：
 * - 普通图片下载（fetch / CapacitorHttp 双通道）
 * - 动图 ZIP 下载
 * - 下载进度回调
 */
import { CapacitorHttp } from '@capacitor/core';
import { createLogger } from '../../utils/logger.js';
import { isNativeDownloadAvailable, nativeDownload } from '../../utils/nativeDownload.js';
import { isDesktopDownloadAvailable, desktopDownload } from '../../utils/desktopDownload.js';

const log = createLogger('NetworkStore');
const IS_DEV = import.meta.env.DEV;

/**
 * 按目标域名给 Referer。
 * Pixiv 图床（pximg / pixiv.re）对缺失 Referer 敏感，必须带；
 * booru 图床不校验，白送 pixiv.net 的假 Referer 既无意义也不诚实。
 */
function refererFor(url) {
  return /pximg\.net|pixiv\.re/i.test(url || '')
    ? 'https://www.pixiv.net/'
    : '';
}

export class NetworkStore {
  /**
   * 下载图片，返回 base64。
   * @param {string} url
   * @returns {Promise<string|null>}
   */
  _absUrl(url) {
    if (!url) return '';
    return url.startsWith('/') ? window.location.origin + url : url;
  }

  async downloadImage(url, onProgress) {
    if (!url) return null;
    const abs = this._absUrl(url);
    log.debug('downloadImage:', { raw: url, abs });
    // 桌面壳：主进程 Node https 流式下载 —— 绕开渲染进程 CORS，且能拿到真实字节进度。
    // 放在最前面是因为它比 CapacitorHttp 快且能报进度，且 dev 模式下也适用。
    if (isDesktopDownloadAvailable()) {
      try {
        const data = await desktopDownload(abs, onProgress);
        if (data) return data;
      } catch (e) {
        log.info('桌面流式下载失败，降级:', e?.message || e);
      }
    }
    // 生产环境：优先原生流式下载（真实字节进度、不受 CORS 限制），失败降级 CapacitorHttp
    if (!IS_DEV) {
      if (isNativeDownloadAvailable()) {
        try {
          const data = await nativeDownload(abs, onProgress);
          if (data) return data;
        } catch (e) {
          log.info('原生下载失败，降级 CapacitorHttp:', e?.message || e);
        }
      }
      // CapacitorHttp 拿不到字节数。这里原本用一条 0→90 的定时估算假装有进度，
      // 结果下载管理显示一个与真实速度无关的百分比（甚至下完前就停在 90%）。
      // 现在直接不报进度：UI 只显示「下载中…」。宁可没有，也不给假数。
      return await this._downloadWithCapacitor(url);
    }
    try {
      const referer = refererFor(abs);
      // 停滞兜底：没有超时的话，卡住的连接会让下载任务永远停在「下载中」
      const resp = await fetch(abs, {
        headers: referer ? { Referer: referer } : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      log.debug('fetch OK, size:', blob.size);
      return await this._blobToBase64(blob);
    } catch (e) {
      log.info('fetch 失败，降级 CapacitorHttp:', e.message);
      return await this._downloadWithCapacitor(url);
    }
  }

  async _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve(fr.result.split(',')[1]);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  async _downloadWithCapacitor(url) {
    try {
      const fullUrl = this._absUrl(url);
      const referer = refererFor(fullUrl);
      const resp = await CapacitorHttp.request({
        method: 'GET', url: fullUrl,
        headers: referer ? { Referer: referer } : {},
        responseType: 'blob', connectTimeout: 30000, readTimeout: 30000,
      });
      if (resp.status < 200 || resp.status >= 300) return null;
      const raw = resp.data;
      if (typeof raw === 'string') {
        return raw.includes(',') ? raw.split(',')[1] : raw;
      }
      if (raw?.data && typeof raw.data === 'string') {
        return raw.data.includes(',') ? raw.data.split(',')[1] : raw.data;
      }
      return null;
    } catch (e) {
      log.debug('CapacitorHttp 下载失败:', e?.message || e);
      return null;
    }
  }
}
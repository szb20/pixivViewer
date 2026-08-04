/**
 * NetworkStore — 网络下载层。
 *
 * 只负责从 Pixiv 下载数据，不关心存储、不关心元数据。
 *
 * 支持：
 * - 普通图片下载（fetch / CapacitorHttp 双通道）
 * - 动图 ZIP 下载
 * - 动图元数据查询（ugoira_meta）
 * - 下载进度回调
 */
import { CapacitorHttp } from '@capacitor/core';
import { createLogger } from '../../utils/logger.js';
import { isNativeDownloadAvailable, nativeDownload } from '../../utils/nativeDownload.js';

const log = createLogger('NetworkStore');
const IS_DEV = import.meta.env.DEV;

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
      return await this._downloadWithCapacitor(url);
    }
    try {
      const resp = await fetch(abs, { headers: { Referer: 'https://www.pixiv.net/' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      log.debug('fetch OK, size:', blob.size);
      return await this._blobToBase64(blob);
    } catch (e) {
      log.info('fetch 失败，降级 CapacitorHttp:', e.message);
      return await this._downloadWithCapacitor(url);
    }
  }

  /**
   * 获取动图元数据（ugoira_meta + illust 详情）。
   * @param {string} illustId
   * @param {string} [cookie]
   * @returns {Promise<object|null>}
   */
  async fetchUgoiraMeta(illustId, cookie) {
    const metaHeaders = {
      'Accept': 'application/json',
      'Referer': `https://www.pixiv.net/artworks/${illustId}`,
    };
    if (cookie) metaHeaders['X-Pixiv-Cookie'] = `PHPSESSID=${cookie}`;

    const [ugoiraResp, illustResp] = await Promise.all([
      fetch(`/pixiv-api/ajax/illust/${illustId}/ugoira_meta`, {
        headers: metaHeaders, signal: AbortSignal.timeout(15000),
      }),
      fetch(`/pixiv-api/ajax/illust/${illustId}`, {
        headers: metaHeaders, signal: AbortSignal.timeout(10000),
      }).catch(() => null),
    ]);

    if (!ugoiraResp.ok) throw new Error(`ugoira_meta HTTP ${ugoiraResp.status}`);
    const meta = (await ugoiraResp.json())?.body;
    if (!meta?.frames?.length) return null;

    // 合并 illust 详情元数据
    if (illustResp?.ok) {
      try {
        const illustDetail = (await illustResp.json())?.body;
        if (illustDetail) {
          meta.userName = illustDetail.userName || meta.userName || '';
          meta.title = illustDetail.illustTitle || illustDetail.title || meta.title || '';
          meta.userAccount = illustDetail.userAccount || meta.userAccount || '';
          meta.userId = illustDetail.userId || meta.userId;
          meta.tags = illustDetail.tags || meta.tags || [];
        }
      } catch (e) { log.debug('illust 详情解析失败（不影响主流程）:', e?.message || e); }
    }

    return meta;
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
      const resp = await CapacitorHttp.request({
        method: 'GET', url: fullUrl,
        headers: { Referer: 'https://www.pixiv.net/' },
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

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

export class NetworkStore {
  /**
   * 下载图片，返回 base64。
   * @param {string} url
   * @returns {Promise<string|null>}
   */
  async downloadImage(url) {
    if (!url) return null;
    try {
      // 优先 fetch
      const resp = await fetch(url, { headers: { Referer: 'https://www.pixiv.net/' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      return await this._blobToBase64(blob);
    } catch {
      // 回退 CapacitorHttp
      return await this._downloadWithCapacitor(url);
    }
  }

  /**
   * 下载 ZIP 包（动图帧），返回 ArrayBuffer。
   * @param {string} url
   * @param {function} [onProgress]
   * @returns {Promise<ArrayBuffer>}
   */
  async downloadZip(url, onProgress) {
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.timeout = 120000;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
        else reject(new Error(`XHR HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('XHR error'));
      xhr.ontimeout = () => reject(new Error('XHR timeout'));
      xhr.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      };
      xhr.send();
    });
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
      } catch { /* illust 详情解析失败不影响主流程 */ }
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
      const resp = await CapacitorHttp.request({
        method: 'GET', url,
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
    } catch {
      return null;
    }
  }
}
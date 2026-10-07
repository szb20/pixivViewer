/**
 * Ugoira 元数据查询（只发小请求，不下载 ZIP）。
 *
 * 自建 transport 实例（与 api/pixiv.js 的 pixivTransport 同参数），不 import pixiv.js：
 * 否则会形成 storageService → ugoira → pixiv.js → pixiv-assistant barrel →
 * storageFacade → storageService 的环。同理这里直连 capacitor/config.js，不走 barrel。
 */
import { createTransport } from '../transport.js';
import { getPixivCookie } from '../../pixiv-assistant/capacitor/config.js';

const ugoiraMetaFetch = createTransport({
  apiPrefix: '/pixiv-api',
  origin: 'https://www.pixiv.net',
  cookieAs: 'x-pixiv-cookie',
  referer: 'https://www.pixiv.net',
  logName: 'ugoiraMeta',
});

/**
 * 查询 ugoira 元数据（帧列表 + ZIP 地址）。
 * @param {string} id — 作品 illustId
 * @returns {Promise<{originalSrc: string, frames: Array<{file: string, delay: number}>, mime_type?: string}>}
 */
export async function fetchUgoiraMeta(id) {
  const cookie = await getPixivCookie();
  const h = {};
  if (cookie) h['Cookie'] = `PHPSESSID=${cookie}`;
  const metaResp = await ugoiraMetaFetch(`/ajax/illust/${id}/ugoira_meta`, { headers: h });
  const body = metaResp?.body;
  if (!body?.originalSrc || !body?.frames?.length) {
    throw new Error(body?.error_message || 'GIF 元数据未找到');
  }
  return body;
}

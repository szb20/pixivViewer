/**
 * Ugoira 元数据查询（只发小请求，不下载 ZIP）。
 *
 * 自建 transport 实例（与 api/pixiv.js 的 pixivTransport 同参数），不 import pixiv.js：
 * 保持 ugoira 子模块与主 API 模块解耦。（历史上这里还曾直连 capacitor/config.js 以
 * 避免 barrel 环，但 barrel 从不 import src/api/**，环不存在，现按统一约定走 barrel。）
 */
import { createTransport } from '../../utils/transport.js';
import { getPixivCookie } from '../../pixiv-assistant/index.js';

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

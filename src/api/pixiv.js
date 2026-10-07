/**
 * Pixiv API 适配层 — 通道选择与鉴权头逻辑已抽到 transport.js，
 * 这里只保留 Pixiv 专有的 Cookie 语义与 API 实例装配。
 */
import { createPixivApi, getPixivCookie } from '../pixiv-assistant/index.js';
import { createLogger } from '../utils/logger.js';
import { createTransport } from './transport.js';

const PIXIV_BASE = 'https://www.pixiv.net';

/**
 * Pixiv 传输实例。Cookie 在 dev / 桌面壳下转成 x-pixiv-cookie 由代理还原透传
 * （浏览器禁止设 Cookie），prod 走 CapacitorHttp 可直设。
 */
export const pixivTransport = createTransport({
  apiPrefix: '/pixiv-api',
  origin: PIXIV_BASE,
  cookieAs: 'x-pixiv-cookie',
  referer: PIXIV_BASE,
  logName: 'pixivFetch',
});

export const pixivApi = createPixivApi({
  fetch: pixivTransport,
  getCookie: getPixivCookie,
  // logger 由外层注入（core 不反向依赖 utils/logger）
  log: createLogger('pixivApi'),
});

/**
 * Pixiv 模块共享工具函数。
 *
 * 纯函数，无 Node/Browser 依赖，Electron 主进程 + React 前端共用。
 */
import { PIXIV_RE } from './constants.js';

/** 运行在浏览器环境（包括 Capacitor WebView）时走 Vite 代理避免 CORS */
const USE_PROXY = typeof window !== 'undefined' && typeof import.meta !== 'undefined' && import.meta.env?.DEV;

/**
 * pixiv.re 短链接（无需代理可访问）
 * 浏览器 dev 模式下通过 /pixiv-img 代理避免 CORS
 * @param {string} illustId
 * @param {number} [page=0]
 * @returns {string}
 */
export function pixivReUrl(illustId, page = 0, size) {
  // pixiv.re 的 -{n} 是 1-indexed：-1=第1页(p0), -2=第2页(p1)
  const suffix = page > 0 ? `-${page + 1}` : '';
  const ext = '.jpg';
  // thumb 模式走裁剪路径，生成 250px 缩略图
  if (size === 'thumb') {
    const path = `c/250x250_80_a2/${illustId}_p${page}${ext}`;
    if (USE_PROXY) return `/pixiv-img/${path}`;
    return `${PIXIV_RE}/${path}`;
  }
  const path = `${illustId}${suffix}${ext}`;
  if (USE_PROXY) return `/pixiv-img/${path}`;
  return `${PIXIV_RE}/${path}`;
}

/**
 * 缩略图 URL 代理：i.pximg.net → i.pixiv.re
 * 浏览器 dev 模式下通过 /pixiv-thumb 代理避免 CORS
 * @param {string} url
 * @returns {string}
 */
export function proxyThumb(url) {
  if (!url) return '';
  const proxied = url.replace(/i\.pximg\.net/gi, 'i.pixiv.re');
  if (USE_PROXY) return proxied.replace(/https:\/\/i\.pixiv\.re/, '/pixiv-thumb');
  return proxied;
}

/**
 * 从 Pixiv API 返回的 page 0 URL 生成指定页码的 i.pixiv.re 图片 URL。
 *
 * Pixiv CDN URL 格式：
 *   https://i.pximg.net/img-master/img/YYYY/MM/DD/HH/MM/SS/{id}_p0_master1200.jpg
 *   https://i.pximg.net/c/250x250_80_a2/img-master/img/.../{id}_p0_square1200.jpg
 * 返回格式：
 *   https://i.pixiv.re/img-master/img/YYYY/MM/DD/HH/MM/SS/{id}_p{page}_master1200.jpg
 *
 * @param {string} baseUrl — Pixiv API 返回的 page 0 URL（任意尺寸）
 * @param {number} page — 目标页码
 * @returns {string}
 */
export function pixivPageUrl(baseUrl, page) {
  if (!baseUrl) {
    console.log('[pixivPageUrl] baseUrl is empty, returning empty');
    return '';
  }

  // 匹配日期路径 + illustId（从各种 URL 格式中提取）
  // 日期格式: YYYY/MM/DD/HH/MM/SS (6组)
  const match = baseUrl.match(/\/(\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2})\/(\d+)_p0_/);
  if (match) {
    const datePath = match[1];
    const illustId = match[2];
    let result = `https://i.pixiv.re/img-master/img/${datePath}/${illustId}_p${page}_master1200.jpg`;
    if (USE_PROXY) result = result.replace(/https:\/\/i\.pixiv\.re/, '/pixiv-img');
    return result;
  }

  // 兜底
  const idMatch = baseUrl.match(/(\d+)/);
  const fallback = pixivReUrl(idMatch ? idMatch[1] : '', page);
  console.log('[pixivPageUrl] no match, using fallback:', { baseUrl, page, fallback });
  return fallback;
}

/**
 * 生成指定页码的原图 URL（original 档）。
 *
 * 兼容两类输入：
 * - i.pximg.net 原图（img-original）：.../{id}_p0.jpg → 替换 _p{n} 后缀
 * - pixiv.re 直链（i.pixiv.re/{id}.jpg 或 {id}-2.jpg）：解析 illustId 后走 pixivReUrl
 *
 * @param {string} baseUrl — 任意原图/缩略图 URL（最好传 original 档）
 * @param {number} [page=0] — 目标页码
 * @returns {string}
 */
export function pixivOriginalUrl(baseUrl, page = 0) {
  if (!baseUrl) return '';
  // i.pximg.net 原图 URL（img-original）：解析 illustId 后走 pixiv.re 原图短链，
  // 避免使用 i.pixiv.re/img-original/ 路径（该路径支持不可靠，可能返回错误图）
  if (baseUrl.includes('img-original') || /_p\d+\.\w+$/.test(baseUrl)) {
    const idMatch = baseUrl.match(/(\d+)_p\d+\.\w+$/);
    if (idMatch) return pixivReUrl(idMatch[1], page);
    return proxyThumb(baseUrl.replace(/_p\d+(?=\.\w+$)/, `_p${page}`));
  }
  // pixiv.re / img-master 缩略图等：优先匹配 _p{n} 前的真实 illustId，
  // 避免误取 URL 里的裁剪尺寸（如 c/250x250_80_a2 中的 250）
  const idMatch = baseUrl.match(/(\d+)_p\d+/) || baseUrl.match(/(\d+)/);
  if (idMatch) return pixivReUrl(idMatch[1], page);
  return baseUrl;
}

/**
 * 从 PHPSESSID 中提取用户 ID（格式: {userId}_{token}）
 * @param {string} cookie
 * @returns {string|null}
 */
export function extractUserIdFromCookie(cookie) {
  if (!cookie) return null;
  const match = cookie.match(/^(\d+)_/);
  return match ? match[1] : null;
}

/**
 * 获取图片的唯一复合键（用于缓存/去重）。
 * @param {Object} img
 * @param {string} [img.illustId]
 * @param {number} [img._pageIndex]
 * @param {number} [img.page]
 * @returns {string}
 */
export function getCompositeKey(img) {
  const id = img.illustId || '';
  const page = img._pageIndex ?? img.page ?? 0;
  return `${id}_${page}`;
}

/**
 * 安全文件名（移除非法字符）
 * @param {string} s
 * @returns {string}
 */
export function safeFileName(s) {
  return (s || '').replace(/[\\:*?"<>|\r\n\t]/g, '').replace(/\//g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * 从文件名解析 illustId、pageIndex、isGif。
 * 支持格式：
 *   12345678.jpg — 仅 ID
 *   12345678_p0.jpg — ID + 页码
 *   12345678_Author_Title.jpg — ID + 作者 + 标题
 *   12345678_p0_Author_Title.jpg — ID + 页码 + 作者 + 标题
 *   pixiv_{id}_g0_[Author]_[Title].gif — 新格式动图（{source}_{id}_g{page}_[{author}]_[{title}]）
 *   pixiv_{id}_p0_[Author]_[Title].jpg — 新格式图片
 *   ugoira_12345.gif — Ugoira 动图（旧）
 *   ugoira_12345_Author_Title.gif — Ugoira 动图 + 作者 + 标题（旧）
 * @param {string} name
 * @returns {{ illustId: string, pageIndex: number, isGif: boolean }|null}
 */
export function parseCacheFileName(name) {
  const extMatch = name.match(/\.(jpg|jpeg|png|gif|webp|zip)$/i);
  if (!extMatch) return null;
  const ext = extMatch[1].toLowerCase();
  const base = name.slice(0, -extMatch[0].length);

  // 新格式动图：{source}_{illustId}_g{page}_[{authorName}]_[{title}].gif
  // 注意：author/title 可能为空（如修复前的遗留文件），用 * 不用 +
  const newGif = base.match(/^pixiv_(\d+)_g(\d+)_\[(.*?)\]_\[(.*)\]$/i);
  if (newGif) {
    return { illustId: newGif[1], pageIndex: parseInt(newGif[2], 10), isGif: true,
      authorName: newGif[3], author: newGif[3], title: newGif[4] };
  }

  // 新格式 ugoira（旧过渡）：pixiv_ugoira_{illustId}[_[{authorName}]_[{title}]]
  const oldNewGif = base.match(/^pixiv_ugoira_(\d+)/i);
  if (oldNewGif) {
    const rest = base.slice(('pixiv_ugoira_' + oldNewGif[1]).length);
    const metaMatch = rest.match(/^_\[(.*?)\]_\[(.*)\]$/);
    return { illustId: oldNewGif[1], pageIndex: 0, isGif: true,
      ...(metaMatch ? { authorName: metaMatch[1], author: metaMatch[1], title: metaMatch[2] } : {}) };
  }

  // 新格式（双括号）：pixiv_{illustId}_p{page}_[{authorName}]_[{title}]
  // 注意：author/title 可能为空，用 * 不用 +
  const doubleBracket = base.match(/^pixiv_(\d+)_p(\d+)_\[(.*?)\]_\[(.*)\]$/);
  if (doubleBracket) {
    return { illustId: doubleBracket[1], pageIndex: parseInt(doubleBracket[2], 10), isGif: false,
      authorName: doubleBracket[3], author: doubleBracket[3], title: doubleBracket[4] };
  }

  // 新格式（单括号，旧文件重命名）：pixiv_{illustId}_p{page}_[{combined}]
  const singleBracket = base.match(/^pixiv_(\d+)_p(\d+)_\[(.*)\]$/);
  if (singleBracket) {
    return { illustId: singleBracket[1], pageIndex: parseInt(singleBracket[2], 10), isGif: false,
      authorName: singleBracket[3], author: singleBracket[3] };
  }

  // 旧格式 ugoira：ugoira_{illustId}[_...]
  const gifMatch = base.match(/^ugoira_(\d+)/i);
  if (gifMatch) {
    return { illustId: gifMatch[1], pageIndex: 0, isGif: true };
  }

  // 旧格式：{illustId}[_p{page}][_...]
  const pixivMatch = base.match(/^(\d+?)(?:_p(\d+))?(?:_|$)/);
  if (pixivMatch) {
    const illustId = pixivMatch[1];
    const pageIndex = pixivMatch[2] ? parseInt(pixivMatch[2], 10) : 0;
    return { illustId, pageIndex, isGif: false };
  }

  return null;
}

/**
 * 获取缓存 key。
 * 注意：pageIndex 默认为 0，确保同一张图永远产生相同的 key，
 * 避免因 pageIndex 传入 undefined 导致不同的 cacheKey 造成重复。
 * @param {string} illustId
 * @param {number} [pageIndex=0]
 * @param {string} [source='pixiv']
 * @returns {string}
 */
export function getCacheKey(illustId, pageIndex = 0, _source = 'pixiv') {
  return `pixiv_${illustId}_${pageIndex}`;
}

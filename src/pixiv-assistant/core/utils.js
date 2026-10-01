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
  // 兼容非字符串字段（如 /ajax/user 的 background 可能是 { url } 对象）
  let target = url;
  if (typeof target === 'object' && target && typeof target.url === 'string') target = target.url;
  if (typeof target !== 'string') return '';
  const proxied = target.replace(/i\.pximg\.net/gi, 'i.pixiv.re');
  if (USE_PROXY) return proxied.replace(/https:\/\/i\.pixiv\.re/, '/pixiv-thumb');
  return proxied;
}

/**
 * 从 Pixiv API 返回的 page 0 URL 生成指定页码的 i.pixiv.re 图片 URL。
 *
 * 支持两类输入：
 *   1. img-master 标准图：…/img-master/img/YYYY/MM/DD/HH/MM/SS/{id}_p{n}_square1200.jpg
 *      → img-master/img/{date}/{id}_p{page}_master{size}.jpg
 *   2. custom-thumb 自定义封面（只存在于第 0 页）：
 *      …/custom-thumb/img/{date}/{id}_p0_custom1200.jpg → 同 1
 *      （custom-thumb 源图是 1200×1200 方形，且无 _p1 变体，页数无关一律改走 img-master）
 *   3. ugoira 动图（无页码后缀）：…/img-master/img/{date}/{id}_square1200.jpg
 *      → img-master/img/{date}/{id}_master{size}.jpg（不加 _p{page}）
 *   4. 2026 起新格式（{id} 后带 32 位内容哈希）：
 *      …/{date}/{id}-{hash32}_p{n}_square1200.jpg → 同 1/2/3 规则
 *
 * @param {string} baseUrl — Pixiv API 返回的 page 0 URL（任意尺寸）
 * @param {number} page — 目标页码
 * @param {number} [size=1200] — master 尺寸（1200=regular，360=最小等比预览）
 * @returns {string}
 */
export function pixivPageUrl(baseUrl, page, size = 1200) {
  if (!baseUrl) return '';

  // 匹配日期路径 + illustId（从各种 URL 格式中提取）
  // 日期格式: YYYY/MM/DD/HH/MM/SS (6组)
  // 2026 起部分新作品 URL 带内容哈希：{id}-{32位hex}_p{n}_…，需容忍 "-hash" 段
  const match = baseUrl.match(/\/(\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2})\/(\d+)(?:-[0-9a-f]{32})?_/);
  if (match) {
    const datePath = match[1];
    const illustId = match[2];

    const basename = baseUrl.split('/').pop();
    // ugoira 无 _p{n}/_u{n} 页码后缀（例: {id}_square1200.jpg），普通图有 _p0/_u0
    const hasPageSuffix = /_(p|u)\d+/.test(basename);

    const pageSuffix = hasPageSuffix ? `_p${page}` : '';
    // 一律走 img-master/_master{size}，不用 custom-thumb：
    // custom-thumb（自定义封面）的源图实测是 1200×1200 方形，任何 c/ 前缀都还原不出等比，
    // 会让网格与详情页首图变方。img-master/{id}_p{page}_master{size} 是同作品的等比图，实测 200。
    let result = `https://i.pixiv.re/img-master/img/${datePath}/${illustId}${pageSuffix}_master${size}.jpg`;
    if (USE_PROXY) result = result.replace(/https:\/\/i\.pixiv\.re/, '/pixiv-img');
    return result;
  }

  // 兜底：从 URL 提取 illustId（优先 ≥7 位数字段，避免误抓 c/250x250 这类裁剪尺寸）
  const parts = baseUrl.match(/\/(\d{7,})(?:-[0-9a-f]{32}|_|\.|$)/);
  const idMatch = parts ? parts[1] : baseUrl.match(/\d{7,}/)?.[0] || baseUrl.match(/(\d+)/)?.[1];
  const fallback = pixivReUrl(idMatch || '', page);
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
    const idMatch = baseUrl.match(/(\d+)(?:-[0-9a-f]{32})?_p\d+\.\w+$/);
    if (idMatch) return pixivReUrl(idMatch[1], page);
    return proxyThumb(baseUrl.replace(/_p\d+(?=\.\w+$)/, `_p${page}`));
  }
  // pixiv.re / img-master 缩略图等：优先匹配 _p{n} 前的真实 illustId（容忍 -hash 段），
  // 避免误取 URL 里的裁剪尺寸（如 c/250x250_80_a2 中的 250）
  const idMatch = baseUrl.match(/(\d+)(?:-[0-9a-f]{32})?_p\d+/) || baseUrl.match(/(\d{7,})/);
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
 *
 * 跨来源隔离靠 illustId 本身全局唯一（见 qualifyId）：pixiv 是裸数字，
 * 其他来源是 `{source}_{站点id}`，因此这里不需要再拼来源。
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

/** 默认来源（历史数据与未标注来源的条目都归它） */
export const DEFAULT_SOURCE = 'pixiv';

/**
 * 已知来源词表。
 * 必须是封闭词表：文件名解析靠它区分"来源前缀"与"标题里的下划线"，
 * 开放匹配会把第三方文件名误认成来源。
 */
export const KNOWN_SOURCES = ['pixiv', 'yande', 'konachan'];

/**
 * 站点原始 id → 全局唯一 illustId。
 *
 * pixiv 保持裸数字，与历史数据逐字节一致（零迁移）；
 * 其他来源加 `{source}_` 前缀，避免与 pixiv 的数字 id 撞号
 * （yande 约 127 万条，其 id 几乎全部落在 pixiv 的 id 区间内）。
 *
 * @param {string} source
 * @param {string|number} rawId — 站点自己的 id
 * @returns {string}
 */
export function qualifyId(source, rawId) {
  const id = String(rawId ?? '');
  if (!id) return '';
  const s = String(source || DEFAULT_SOURCE);
  return s === DEFAULT_SOURCE ? id : `${s}_${id}`;
}

/**
 * illustId → 来源。未知形态一律按 pixiv 处理（fail-safe，不抛错）。
 * @param {string} illustId
 * @returns {string}
 */
export function sourceOfId(illustId) {
  const s = String(illustId ?? '');
  const i = s.indexOf('_');
  if (i <= 0) return DEFAULT_SOURCE;
  const head = s.slice(0, i);
  return KNOWN_SOURCES.includes(head) ? head : DEFAULT_SOURCE;
}

/**
 * illustId → 站点原始 id。
 * 拼文件名必须用它：`yande_1269655` 里的 `_` 合法，但若误把带来源的
 * illustId 直接拼进去，扩展名/前缀就会串味。
 * @param {string} illustId
 * @returns {string}
 */
export function rawIdOf(illustId) {
  const s = String(illustId ?? '');
  const src = sourceOfId(s);
  return src === DEFAULT_SOURCE ? s : s.slice(src.length + 1);
}

/** 单个字符的 UTF-8 字节数 */
export function utf8ByteLen(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/**
 * 按 UTF-8 字节数截断（不会切碎多字节字符）。
 * Android 的 MediaStore / ext4 单个文件名上限是 255 **字节**，不是字符：
 * 日文标题 80 字符 ≈ 240 字节，加上前缀与作者段就会 ENOMETOOLONG 写入失败。
 * @param {string} s
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8Bytes(s, maxBytes) {
  const str = String(s ?? '');
  if (!(maxBytes > 0)) return '';
  let used = 0;
  let out = '';
  for (const ch of str) {
    const b = utf8ByteLen(ch);
    if (used + b > maxBytes) break;
    used += b;
    out += ch;
  }
  return out;
}

/**
 * 安全文件名（移除非法字符，并按字节截断）
 * @param {string} s
 * @returns {string}
 */
export function safeFileName(s) {
  const cleaned = (s || '').replace(/[\\:*?"<>|\r\n\t]/g, '').replace(/\//g, '-').replace(/\s+/g, ' ').trim();
  return truncateUtf8Bytes(cleaned, 80);
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
 *   yande_{id}_p0_[Author]_[Title].jpg — 非 Pixiv 来源（同上格式，前缀换成来源名）
 *   ugoira_12345.gif — Ugoira 动图（旧）
 *   ugoira_12345_Author_Title.gif — Ugoira 动图 + 作者 + 标题（旧）
 * @param {string} name
 * @returns {{ illustId: string, pageIndex: number, isGif: boolean, source?: string }|null}
 */
export function parseCacheFileName(name) {
  const extMatch = name.match(/\.(jpg|jpeg|png|gif|webp|zip)$/i);
  if (!extMatch) return null;
  const base = name.slice(0, -extMatch[0].length);

  // 非 Pixiv 来源：{source}_{rawId}_p|g{page}_[{author}]_[{title}]
  // 单独开一支（而非放宽下面 pixiv 分支的 `(\d+)`），这样 Pixiv 老文件的解析路径一字不动。
  // 用 KNOWN_SOURCES 白名单：否则标题里恰好含 `x_12_p0_[..]` 的第三方文件会被误认。
  const altSource = base.match(/^([a-z][a-z0-9]*)_(\d+)_(p|g)(\d+)_\[(.*?)\]_\[(.*)\]$/);
  if (altSource && altSource[1] !== 'pixiv' && KNOWN_SOURCES.includes(altSource[1])) {
    return {
      source: altSource[1],
      illustId: qualifyId(altSource[1], altSource[2]),
      pageIndex: parseInt(altSource[4], 10),
      isGif: altSource[3] === 'g',
      authorName: altSource[5], author: altSource[5], title: altSource[6],
    };
  }

  // 新格式动图：{source}_{illustId}_g{page}_[{authorName}]_[{title}].gif
  // 注意：author/title 可能为空（如修复前的遗留文件），用 * 不用 +
  const newGif = base.match(/^pixiv_(\d+)_g(\d+)_\[(.*?)\]_\[(.*)\]$/i);
  if (newGif) {
    return {
      illustId: newGif[1], pageIndex: parseInt(newGif[2], 10), isGif: true,
      authorName: newGif[3], author: newGif[3], title: newGif[4]
    };
  }

  // 新格式 ugoira（旧过渡）：pixiv_ugoira_{illustId}[_[{authorName}]_[{title}]]
  const oldNewGif = base.match(/^pixiv_ugoira_(\d+)/i);
  if (oldNewGif) {
    const rest = base.slice(('pixiv_ugoira_' + oldNewGif[1]).length);
    const metaMatch = rest.match(/^_\[(.*?)\]_\[(.*)\]$/);
    return {
      illustId: oldNewGif[1], pageIndex: 0, isGif: true,
      ...(metaMatch ? { authorName: metaMatch[1], author: metaMatch[1], title: metaMatch[2] } : {})
    };
  }

  // 新格式（双括号）：pixiv_{illustId}_p{page}_[{authorName}]_[{title}]
  // 注意：author/title 可能为空，用 * 不用 +
  const doubleBracket = base.match(/^pixiv_(\d+)_p(\d+)_\[(.*?)\]_\[(.*)\]$/);
  if (doubleBracket) {
    return {
      illustId: doubleBracket[1], pageIndex: parseInt(doubleBracket[2], 10), isGif: false,
      authorName: doubleBracket[3], author: doubleBracket[3], title: doubleBracket[4]
    };
  }

  // 新格式（单括号，旧文件重命名）：pixiv_{illustId}_p{page}_[{combined}]
  const singleBracket = base.match(/^pixiv_(\d+)_p(\d+)_\[(.*)\]$/);
  if (singleBracket) {
    return {
      illustId: singleBracket[1], pageIndex: parseInt(singleBracket[2], 10), isGif: false,
      authorName: singleBracket[3], author: singleBracket[3]
    };
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
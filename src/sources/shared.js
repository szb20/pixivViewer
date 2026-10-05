/**
 * 非 Pixiv 适配器的公共件 —— moebooru / danbooru / gelbooru / wallhaven 共用。
 *
 * 这几个站的协议各不相同（字段名、分页基准、排序语法），但有三件事完全一样：
 * 错误分类、从用户输入里抽站点 id、单图条目 → 详情页 illust 结构。
 * 放这里免得四份拷贝各自漂移。
 */

/**
 * 部分站点（Danbooru / Cloudflare 后面的图床）会拒掉「浏览器 UA + 非浏览器 TLS 指纹」的组合。
 * 实测 danbooru.donmai.us 与 cdn.donmai.us：
 *   Mozilla/5.0 ... Chrome/131  → 403（JS 挑战）
 *   PixivViewer/1.0             → 200
 * 所以这类来源的 API / 图片代理必须显式声明一个非浏览器 UA（见 registry 的 net.userAgent）。
 * 真机 <img> 由 WebView 发起，指纹与 UA 自洽，不受影响。
 */
export const API_CLIENT_UA = 'PixivViewer/1.0';

/**
 * HTTP 错误 → 用户可读文案。
 * @param {any} e
 * @param {string} what — 「搜索」「排行榜」等，拼进提示语
 */
export function classifyError(e, what) {
  const msg = e?.message || String(e);
  if (/Failed to fetch|NetworkError|ERR_NETWORK|ENOTFOUND|ECONNREFUSED|abort|timeout/i.test(msg)) {
    return `网络连接失败（${what}），请检查网络或代理设置`;
  }
  const code = typeof e?.status === 'number' ? e.status : Number(msg.match(/HTTP\s+(\d+)/)?.[1]);
  if (code === 401) return `${what}需要 API Key`;
  if (code === 403) return `${what}被拒绝访问（403）`;
  if (code === 404) return `${what}未找到，可能已被删除`;
  if (code === 429) return '请求过于频繁，请稍后再试';
  if (code >= 500) return `${what}服务暂时不可用，请稍后重试`;
  if (code) return `${what}请求失败（HTTP ${code}）`;
  return msg;
}

/**
 * 从用户输入里抽站点原始 id：纯数字，或匹配指定正则的链接。
 * @param {string} query
 * @param {RegExp} pattern — 需带一个捕获组
 * @returns {string} 未命中返回 ''
 */
export function extractPostId(query, pattern) {
  const fromUrl = String(query || '').match(pattern)?.[1];
  if (fromUrl) return fromUrl;
  return /^\d+$/.test(query) ? String(query) : '';
}

/**
 * 统一条目 → 详情页需要的 illust 结构（与 pixiv fetchIllust 的返回形状对齐）。
 *
 * 这些来源一条 post = 一张图，没有多页插画，所以 images 恒为单元素数组。
 * @param {object} item — mapPost 产出的统一条目
 */
export function toIllust(item) {
  return {
    illustId: item.illustId,
    title: item.title,
    authorName: item.authorName,
    authorAccount: '',
    authorId: '',
    tags: item.tags,
    pageCount: 1,
    illustType: 0,
    width: item.width,
    height: item.height,
    webUrl: item.webUrl,
    images: [{
      index: 0,
      url: item.mediumUrl,
      previewUrl: item.mediumUrl,
      thumbnailUrl: item.thumbnailUrl,
      mediumUrl: item.mediumUrl,
      originalUrl: item.originalUrl,
      width: item.width,
      height: item.height,
    }],
  };
}

/**
 * 解析 `"1920x1080"` 这类分辨率字符串（Wallhaven 的 resolution 字段）。
 * @returns {{width:number, height:number}}
 */
export function parseResolution(text) {
  const m = String(text || '').match(/^(\d+)\s*x\s*(\d+)$/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 0, height: 0 };
}

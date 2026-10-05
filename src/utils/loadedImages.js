/**
 * 已加载图片登记表 —— 会话级，记「这张图的字节已经在浏览器缓存里了」。
 *
 * 用途：详情页同一张图会按档位排队加载（540 占位 → master1200 预览 → 原图）。
 * 原图一旦加载过，再打开这个作品时 master1200 就是纯浪费 —— 原图已在缓存，
 * 直接拿原图当预览即可（缓存命中，零网络）。见 ImageDetailView 的 reuseHd。
 *
 * 为什么按 URL 而不是按 illustId：判断依据是「这个 URL 的响应进过缓存」，
 * 而 URL 才是缓存键。pixiv 图床返回 `Cache-Control: max-age=31536000`，
 * 所以本会话内加载成功过的 URL，后续命中缓存的把握很大。
 *
 * 为什么不做持久化：跨重启后本表会清空，但磁盘缓存仍在 —— 属漏判（多拉一次
 * master1200），不会误判。反过来若持久化，缓存被淘汰时会误判成「已缓存」，
 * 代价是详情页少一层渐进预览（原图本来就要加载，不会多花流量）。等确认收益后再说。
 */

/** @type {Set<string>} */
const loaded = new Set();

/** 登记一个加载成功（onLoad 已触发）的图片 URL */
export function markImageLoaded(url) {
  if (typeof url === 'string' && url) loaded.add(url);
}

/** 该 URL 的响应是否已经在本会话内加载成功过 */
export function isImageLoaded(url) {
  return typeof url === 'string' && !!url && loaded.has(url);
}

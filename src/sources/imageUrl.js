/**
 * 图片来源 URL 工具 — 非 Pixiv 站点的图片地址按运行环境选通道。
 *
 * 只服务「下载」这条路径：<img> 标签不受 CORS 限制，直链在 dev / 桌面 / 手机都能显示；
 * 但 fetch 下载在浏览器 dev 下会被 CORS 拦（yande 图床不返回 CORS 头），
 * 因此 dev 下把图床域名换成同源代理前缀（/yande-img 等，见 scripts/booru-proxy.mjs）。
 */
import { getSource } from './registry.js';

const USE_PROXY = typeof window !== 'undefined' && typeof import.meta !== 'undefined' && import.meta.env?.DEV;

/**
 * 把某来源的图片 URL 转为当前环境下可 fetch 的地址。
 * 不匹配任何已知图床域（或非 dev 环境）时原样返回。
 * @param {string} url
 * @param {string} source — 'yande' | 'konachan' | …
 * @returns {string}
 */
export function fetchableImageUrl(url, source) {
  if (!url || typeof url !== 'string') return '';
  if (!USE_PROXY) return url;
  const hosts = getSource(source).net.imgHosts;
  for (const [host, prefix] of Object.entries(hosts)) {
    for (const scheme of ['https://', 'http://']) {
      const base = `${scheme}${host}`;
      if (url.startsWith(`${base}/`)) return prefix + url.slice(base.length);
    }
  }
  return url;
}

/**
 * 给出某来源图片的全部可 fetch 候选（去重、保序）。
 * @param {object} item
 * @returns {string[]}
 */
export function fetchableImageUrls(item) {
  if (!item) return [];
  const source = item.source || 'pixiv';
  const list = [item.originalUrl, item.mediumUrl, item.thumbnailUrl]
    .filter(Boolean)
    .map(u => fetchableImageUrl(u, source));
  return [...new Set(list)];
}
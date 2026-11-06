/**
 * 统一保存入口 — 动图/静图分流 + 并发去重。
 *
 * 动图（Ugoira，只有 Pixiv 有此类型）走 api/ugoira/saveGif.js（ZIP 解帧 →
 * GIF 编码 → 相册导出）；静态图走 storageFacade.saveFromNetwork（原图优先下载）。
 * 分流在此（API 层用例编排）而非存储层 —— 避免存储层反向依赖 API 层形成包级环。
 */
import { storageFacade, configurePixiv } from '../pixiv-assistant/index.js';
import { saveGifFromNetwork } from './ugoira/saveGif.js';
import { fetchableImageUrls } from '../sources/imageUrl.js';

// 注入非 Pixiv 来源的下载 URL 改写（dev 下把图床域名换成同源代理前缀，见 sources/imageUrl.js）。
// 存储层（pixiv-assistant）不 import sources 以保持独立，本层是能同时看见两边的编排层。
configurePixiv({ foreignDownloadUrls: fetchableImageUrls });

// 进行中的保存请求（按 作品ID_页码 去重），避免并发重复下载/重复提示。
// 动图统一页 0，与静图共用同一键空间。
const saveInFlight = new Map();

/**
 * 统一保存入口 —— 调用方无需关心动图/静图差异。
 * @param {object} item — 图片条目（含 type / illustType / illustId / 各 URL）
 * @returns {Promise<{success: boolean, ...}>}
 */
export function saveItem(item) {
  if (!item?.illustId) return Promise.resolve({ success: false, error: 'invalid_item' });
  // 动图（Ugoira）：只有 Pixiv 有此类型；booru 条目恒为静态图
  const isPixiv = !item.source || item.source === 'pixiv';
  const isGif = isPixiv && (item.type === 'gif' || Number(item.illustType) === 2);
  const key = `${item.illustId}_${isGif ? 0 : (item._pageIndex ?? 0)}`;
  // 同一张图并发保存（自动保存 + 点♡等）共享同一个 promise：只下载一次
  const inFlight = saveInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = isGif ? saveGifFromNetwork(item) : storageFacade.saveFromNetwork(item);
  saveInFlight.set(key, promise);
  promise.catch(() => { }); // finally 链上的 rejection 不算 unhandled（与原门面行为一致）
  promise.finally(() => saveInFlight.delete(key));
  return promise;
}

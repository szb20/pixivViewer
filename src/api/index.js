/**
 * 统一保存入口。
 *
 * 动图/静图分流已下沉到 storageService.saveFromNetwork（动图走 Ugoira 通道，
 * 静态图走原图优先下载），saveItem 只透传门面 —— 门面层做参数校验与并发去重。
 */
import { storageFacade } from '../pixiv-assistant/index.js';

/**
 * 统一保存入口 —— 调用方无需关心动图/静图差异。
 * @param {object} item — 图片条目（含 type / illustType / illustId / 各 URL）
 * @returns {Promise<{success: boolean, ...}>}
 */
export function saveItem(item) {
  return storageFacade.saveFromNetwork(item);
}

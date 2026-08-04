/**
 * 统一保存入口。
 *
 * 历史：这里曾是 window.api 兼容层（llm-chat 组件按 window.api 约定调用）。
 * 新代码已全部改为直接 import：
 *   - pixivApi            → ./pixiv.js
 *   - fetchUgoiraFrames   → ./gif.js
 *   - storageFacade       → ../pixiv-assistant/index.js
 * 仅保留 saveItem 统一分发（动图/静图差异）。
 */
import { fetchUgoiraFrames, saveGifToAlbum } from './gif.js';
import { storageFacade } from '../pixiv-assistant/index.js';

/**
 * 统一保存入口 —— 调用方无需关心动图/静图差异：
 * GIF → saveGifToAlbum（ZIP 解码 + GIF 编码）；
 * 静态图 → storageFacade.saveFromNetwork（原图优先下载）。
 * @param {object} item — 图片条目（含 type / illustType / illustId / 各 URL）
 * @returns {Promise<{success: boolean, ...}>}
 */
export function saveItem(item) {
  if (item?.type === 'gif' || Number(item?.illustType) === 2) {
    return saveGifToAlbum(item);
  }
  return storageFacade.saveFromNetwork(item);
}

// 供需要时直接使用的动图加载入口（GifPlayer/UgoiraPlayer 的共享实现也直接引用它）
export { fetchUgoiraFrames };

/**
 * window.api 兼容层 — llm-chat 组件按 window.api 约定调用，
 * 新 app 在这里把 pixivApi + storageFacade 组装成同一面。
 */
import { pixivApi } from './pixiv.js';
import { fetchUgoiraFrames, saveGifToAlbum } from './gif.js';
import { storageFacade } from '../pixiv-assistant/index.js';

/**
 * 统一保存入口 — 调用方无需关心动图/静图差异：
 * GIF → saveGifToAlbum（ZIP 解码 + GIF 编码）
 * 静态图 → storageFacade.saveFromNetwork（原图优先下载）
 */
function saveItem(item) {
  if (item?.type === 'gif' || Number(item?.illustType) === 2) {
    return saveGifToAlbum(item);
  }
  return storageFacade.saveFromNetwork(item);
}

window.api = {
  storageFacade,
  fetchIllust: (illustId) => pixivApi.fetchIllust(illustId),
  fetchRelated: (illustId, opts) => pixivApi.fetchRelated(illustId, opts),
  fetchUserIllusts: (userId, opts) => pixivApi.fetchUserIllusts(userId, opts),
  toggleLike: (illustId, pageIndex) => storageFacade.toggleLike(illustId, pageIndex),
  fetchGif: (illustId, onProgress, opts) => fetchUgoiraFrames(illustId, onProgress, opts),
  fetchUgoira: (illustId, onProgress, opts) => fetchUgoiraFrames(illustId, onProgress, opts),
  saveItem,
  // 旧名兼容：cachePixivImage 与 saveItem 等价
  cachePixivImage: saveItem,
  scanExistingFiles: () => Promise.resolve([]),
};

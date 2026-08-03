/**
 * window.api 兼容层 — llm-chat 组件按 window.api 约定调用，
 * 新 app 在这里把 pixivApi + storageFacade 组装成同一面。
 */
import { pixivApi } from './pixiv.js';
import { fetchUgoiraFrames, saveGifToAlbum } from './gif.js';
import { storageFacade } from '../pixiv-assistant/index.js';

window.api = {
  storageFacade,
  fetchIllust: (illustId) => pixivApi.fetchIllust(illustId),
  fetchRelated: (illustId, opts) => pixivApi.fetchRelated(illustId, opts),
  toggleLike: (illustId, pageIndex) => storageFacade.toggleLike(illustId, pageIndex),
  fetchGif: (illustId, onProgress, opts) => fetchUgoiraFrames(illustId, onProgress, opts),
  fetchUgoira: (illustId, onProgress, opts) => fetchUgoiraFrames(illustId, onProgress, opts),
  // 旧版图片缓存接口：GIF 走动图编码保存，静态图走 storageFacade
  cachePixivImage: (item) => {
    if (item?.type === 'gif' || Number(item?.illustType) === 2) {
      return saveGifToAlbum(item);
    }
    return storageFacade.saveFromNetwork(item);
  },
  scanExistingFiles: () => Promise.resolve([]),
};

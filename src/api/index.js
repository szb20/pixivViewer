/**
 * window.api 兼容层 — llm-chat 组件按 window.api 约定调用，
 * 新 app 在这里把 pixivApi + storageFacade 组装成同一面。
 */
import { pixivApi } from './pixiv.js';
import { fetchUgoiraFrames } from './gif.js';
import { storageFacade } from '../pixiv-assistant/index.js';

window.api = {
  storageFacade,
  fetchIllust: (illustId) => pixivApi.fetchIllust(illustId),
  fetchRelated: (illustId, opts) => pixivApi.fetchRelated(illustId, opts),
  toggleLike: (illustId, pageIndex) => storageFacade.toggleLike(illustId, pageIndex),
  fetchGif: (illustId, onProgress) => fetchUgoiraFrames(illustId, onProgress),
  fetchUgoira: (illustId, onProgress) => fetchUgoiraFrames(illustId, onProgress),
  // 旧版图片缓存接口（GIF 回退用），新 app 走 storageFacade
  cachePixivImage: () => Promise.resolve({ error: 'not_supported' }),
  scanExistingFiles: () => Promise.resolve([]),
};

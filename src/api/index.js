/**
 * window.api 兼容层 — llm-chat 组件按 window.api 约定调用，
 * 新 app 在这里把 pixivApi + storageFacade 组装成同一面。
 */
import { pixivApi } from './pixiv.js';
import { storageFacade } from '../pixiv-assistant/index.js';

window.api = {
  storageFacade,
  fetchIllust: (illustId) => pixivApi.fetchIllust(illustId),
  fetchRelated: (illustId, opts) => pixivApi.fetchRelated(illustId, opts),
  toggleLike: (illustId, pageIndex) => storageFacade.toggleLike(illustId, pageIndex),
  // GIF 播放器待接入（需要 ZIP 下载 + 解码），先返回失败
  fetchGif: () => Promise.resolve({ error: 'gif_not_supported', message: '动图播放器待接入' }),
  fetchUgoira: () => Promise.resolve({ error: 'gif_not_supported', message: '动图播放器待接入' }),
  // 旧版图片缓存接口（GIF 回退用），新 app 走 storageFacade
  cachePixivImage: () => Promise.resolve({ error: 'not_supported' }),
  scanExistingFiles: () => Promise.resolve([]),
};

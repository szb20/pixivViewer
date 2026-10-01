/**
 * 来源 API 门面 — 页面只问「这个来源的适配器是什么」，
 * 不关心背后是 Moebooru 还是别的协议。
 */
import { getSource } from './registry.js';
import { getMoebooruSource } from './moebooru.js';

/**
 * 取非 Pixiv 来源的适配器；Pixiv 返回 null（Pixiv 走 api/pixiv.js 的 pixivApi）。
 * 页面据此分流，而不是散落 source === 'pixiv' 判断。
 * @param {string} sourceId
 * @returns {ReturnType<typeof getMoebooruSource>}
 */
export function booruApiFor(sourceId) {
  const def = getSource(sourceId);
  if (def.kind === 'moebooru') return getMoebooruSource(sourceId);
  return null;
}

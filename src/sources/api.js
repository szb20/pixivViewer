/**
 * 来源 API 门面 — 页面只问「这个来源的适配器是什么」，
 * 不关心背后是 Moebooru 还是 Danbooru 还是别的协议。
 */
import { getSource } from './registry.js';
import { createMoebooruSource } from './moebooru.js';
import { createDanbooruSource } from './danbooru.js';
import { createGelbooruSource } from './gelbooru.js';
import { createWallhavenSource } from './wallhaven.js';
import { createZerochanSource } from './zerochan.js';

/** kind → 适配器工厂。新增协议只需在这里补一行 + 在 registry 里写 kind */
const FACTORIES = {
  moebooru: createMoebooruSource,
  danbooru: createDanbooruSource,
  gelbooru: createGelbooruSource,
  wallhaven: createWallhavenSource,
  zerochan: createZerochanSource,
};

/** 单例缓存：每个来源一个适配器实例（跨渲染保持会话内状态，也避免重复建 transport） */
const instances = new Map();

/**
 * 取非 Pixiv 来源的适配器；Pixiv 返回 null（Pixiv 走 api/pixiv.js 的 pixivApi）。
 * 页面据此分流，而不是散落 source === 'pixiv' 判断。
 * @param {string} sourceId
 * @returns {ReturnType<typeof createMoebooruSource>|null}
 */
export function booruApiFor(sourceId) {
  const def = getSource(sourceId);
  const create = FACTORIES[def.kind];
  if (!create) return null;
  if (!instances.has(def.id)) instances.set(def.id, create(def));
  return instances.get(def.id);
}

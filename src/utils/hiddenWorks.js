import { useSyncExternalStore } from 'react';
import { getMeta, putMeta } from '../pixiv-assistant/capacitor/cacheDB.js';

/**
 * hiddenWorks — 用户"不想看"的作品集合。
 *
 * 持久化到 IndexedDB 主库（记录 `_meta_hidden_works`），随主库一起备份，
 * 卸载重装后仍保留；旧版本存在 localStorage（pixiv_hidden_works）会自动迁移。
 */
const META_KEY = '_meta_hidden_works';
const LEGACY_KEY = 'pixiv_hidden_works';
const listeners = new Set();
let hidden = new Set();

function emit() {
  for (const fn of [...listeners]) fn();
}

export const hiddenWorks = {
  has(id) { return hidden.has(String(id)); },

  /** 返回当前隐藏列表（数组拷贝，供备份用） */
  getList() { return [...hidden]; },

  add(id) {
    hidden = new Set(hidden).add(String(id)); // 每次新建 Set 保证订阅刷新
    emit();
    putMeta({ cacheKey: META_KEY, hidden: [...hidden] }).catch(() => {});
  },

  /** 整体替换（恢复备份时用），并持久化 */
  replace(list) {
    hidden = new Set((Array.isArray(list) ? list : []).map(String));
    emit();
    putMeta({ cacheKey: META_KEY, hidden: [...hidden] }).catch(() => {});
  },

  /** 启动时从 IndexedDB 加载（并迁移旧 localStorage 数据） */
  async init() {
    let legacy = null;
    try { legacy = localStorage.getItem(LEGACY_KEY); } catch { /* 忽略 */ }

    try {
      const rec = await getMeta(META_KEY);
      if (Array.isArray(rec?.hidden)) hidden = new Set(rec.hidden.map(String));
    } catch { /* 保持空 */ }

    if (legacy != null) {
      try {
        const arr = JSON.parse(legacy);
        if (Array.isArray(arr)) hidden = new Set([...hidden, ...arr.map(String)]);
      } catch { /* 忽略 */ }
      try { localStorage.removeItem(LEGACY_KEY); } catch { /* 忽略 */ }
      await putMeta({ cacheKey: META_KEY, hidden: [...hidden] }).catch(() => {});
    }
    emit();
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  getSnapshot() { return hidden; },
};

/** React hook：订阅隐藏集合 */
export function useHiddenWorks() {
  return useSyncExternalStore(hiddenWorks.subscribe, hiddenWorks.getSnapshot);
}

/**
 * appStorage — 统一的小数据存储（localStorage 单 key）。
 *
 * 设置 / 搜索历史 / 一次性标记等"小配置"都收进 pixiv_viewer_app 一个键下，
 * 避免散落多个 localStorage 键。结构化大对象（作品记录）走 IndexedDB。
 */
const KEY = 'pixiv_viewer_app';

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cache || {})); } catch { /* 忽略 */ }
}

export const appStorage = {
  get(ns, fallback = undefined) {
    const v = load()[ns];
    return v === undefined ? fallback : v;
  },
  set(ns, value) {
    const c = load();
    c[ns] = value;
    save();
  },
  remove(ns) {
    const c = load();
    delete c[ns];
    save();
  },
};

/**
 * 把旧的独立 localStorage key 迁移到统一 key 下（读旧 key → 写入 appStorage.ns → 删除旧 key）。
 * @returns {boolean} 是否迁移了
 */
export function migrateFromLegacyKey(legacyKey, ns) {
  let value = null;
  try { value = localStorage.getItem(legacyKey); } catch { return false; }
  if (value == null) return false;
  try {
    appStorage.set(ns, JSON.parse(value));
  } catch {
    appStorage.set(ns, value);
  }
  try { localStorage.removeItem(legacyKey); } catch { /* 忽略 */ }
  return true;
}

/**
 * vitest 全局 setup — node 环境没有 localStorage，appStorage/mediaDims 需要。
 * 极简 stub：只实现 getItem/setItem/removeItem，模块加载期（appStorage.load 等）可用。
 */
const store = new Map();

globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

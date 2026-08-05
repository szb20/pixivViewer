/**
 * Pixiv Tab 结果缓存 — IndexedDB 持久化，带 TTL 过期。
 *
 * 用于 Tab 间切换时避免重复请求，App 重启后仍可恢复。
 * 用户可点击当前 Tab 强制重新请求。
 */
import { createLogger } from '../../utils/logger.js';

const log = createLogger('tabCache');

const DB_NAME = 'teyvat_pixiv_tabs';
const DB_VERSION = 2;
const STORE = 'tabs';

/** 各 Tab 的 TTL（毫秒），统一 24 小时 */
const TTL_MAP = {
  discover: 24 * 60 * 60 * 1000,
  ranking: 24 * 60 * 60 * 1000,
  bookmarks: 24 * 60 * 60 * 1000,
  following: 24 * 60 * 60 * 1000,
};
const DEFAULT_TTL = 24 * 60 * 60 * 1000;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not available'));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      } else if (e.oldVersion < 2) {
        // v1 → v2：清空旧缓存，强制重新拉取（旧条目缺少 authorAvatar 等新字段）
        e.target.transaction.objectStore(STORE).clear();
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 解析 key 获取 TTL */
function getTTL(key) {
  const base = key.startsWith('ranking:') ? 'ranking' : key;
  return TTL_MAP[base] || DEFAULT_TTL;
}

/**
 * 保存一个 tab 的缓存数据
 * @param {string} key — 如 'discover' / 'ranking:daily_r18' / 'bookmarks'
 * @param {*} data — 序列化后的缓存内容
 */
export async function saveTabCache(key, data) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put({ key, data, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // IndexedDB 不可用时静默失败
    log.debug('saveTabCache 失败:', e?.message || e);
  }
}

/**
 * 读取一个 tab 的缓存数据，过期返回 null
 * @param {string} key
 * @returns {*|null}
 */
export async function loadTabCache(key) {
  try {
    const db = await openDB();
    const ttl = getTTL(key);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        const record = req.result;
        if (!record) return resolve(null);
        if (Date.now() - record.updatedAt > ttl) {
          // 过期 — 后台删除
          deleteTabCache(key).catch(() => {});
          return resolve(null);
        }
        resolve(record.data);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    log.debug('loadTabCache 失败:', e?.message || e);
    return null;
  }
}

/**
 * 批量加载所有缓存（用于组件挂载时恢复）
 * @returns {Object} { [key]: data }
 */
export async function loadAllTabCaches() {
  try {
    const db = await openDB();
    const now = Date.now();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const records = req.result || [];
        const result = {};
        const expiredKeys = [];
        for (const rec of records) {
          const ttl = getTTL(rec.key);
          if (now - rec.updatedAt > ttl) {
            expiredKeys.push(rec.key);
          } else {
            result[rec.key] = rec.data;
          }
        }
        // 后台清理过期条目
        if (expiredKeys.length > 0) {
          cleanupExpired(expiredKeys).catch(() => {});
        }
        resolve(result);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    log.debug('loadAllTabCaches 失败:', e?.message || e);
    return {};
  }
}

/** 删除一个 tab 的缓存 */
export async function deleteTabCache(key) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    log.debug('deleteTabCache 失败:', e?.message || e);
  }
}

/** 批量清理过期条目 */
async function cleanupExpired(keys) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const key of keys) {
      store.delete(key);
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    log.debug('cleanupExpired 失败:', e?.message || e);
  }
}

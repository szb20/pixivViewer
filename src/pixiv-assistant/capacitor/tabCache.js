/**
 * Pixiv Tab 结果缓存 — IndexedDB 持久化，带 TTL 过期。
 *
 * 用于 Tab 间切换时避免重复请求，App 重启后仍可恢复。
 * 用户可点击当前 Tab 强制重新请求。
 */
import { createLogger } from '../../utils/logger.js';

const log = createLogger('tabCache');

const DB_NAME = 'teyvat_pixiv_tabs';
const DB_VERSION = 4;
const STORE = 'tabs';
/** 升级被旧连接阻塞时的宽限期：超过即放弃本次打开（缓存降级为直连），避免 promise 永远挂着 */
const BLOCKED_GRACE_MS = 3000;

/** 各 Tab 的 TTL（毫秒），统一 24 小时 */
const TTL_MAP = {
  discover: 24 * 60 * 60 * 1000,
  ranking: 24 * 60 * 60 * 1000,
  bookmarks: 24 * 60 * 60 * 1000,
  following: 24 * 60 * 60 * 1000,
};
const DEFAULT_TTL = 24 * 60 * 60 * 1000;

let _db = null;
let _dbPromise = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not available'));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      } else if (e.oldVersion < 4) {
        // v1 → v2：清空旧缓存，强制重新拉取（旧条目缺少 authorAvatar 等新字段）
        // v2 → v3：同样清空 —— Wallhaven 条目里缓存的 mediumUrl 指向固定比例的裁剪缩略图
        //   （实测恒为 300×200），详情页会按错误比例显示；重拉一次即修正。
        // v3 → v4：还是清空 —— Wallhaven 条目缓存的 thumbnailUrl 是 small（恒 300×200 的
        //   裁剪），网格里等于只展示原图中间挖出来的一块；改用等比的 thumbs.original 后，
        //   旧缓存不重拉就看不到修正。
        e.target.transaction.objectStore(STORE).clear();
      }
    };
    let settled = false;
    const settle = (fn, val) => { if (settled) return; settled = true; fn(val); };
    req.onsuccess = () => {
      // 已过宽限期、按失败处理后才到达的迟到连接：关掉它，
      // 别让它占着旧版本把下一次升级同样堵死（同 cacheDB.js 的处理）
      if (settled) { req.result.close(); return; }
      _db = req.result;
      settle(resolve, _db);
    };
    req.onerror = () => settle(reject, req.error);
    // 被旧连接阻塞时 open 既不 success 也不 error，promise 会永远挂着：
    // useTabFeed 的水合 await 永不返回 → hydrated 不置位 → 首拉不发、页面一直转圈。
    // 宽限几秒后按失败处理，让上层 catch 后走网络。
    req.onblocked = () => {
      log.warn('tabCache 升级被其他连接阻塞（可能有旧页面未关闭），3 秒后放弃');
      setTimeout(() => {
        if (settled) return;
        log.warn('tabCache 仍被阻塞，本次打开按失败处理（缓存降级为直连）');
        settle(reject, new Error('IndexedDB open blocked'));
      }, BLOCKED_GRACE_MS);
    };
  }).finally(() => { _dbPromise = null; });
  return _dbPromise;
}

/** 解析 key 获取 TTL。
 * key 形如 `{source}:discover` / `{source}:ranking:{mode}` —— 用 includes 而非
 * startsWith，来源前缀不会让 TTL 查找落空。 */
function getTTL(key) {
  return key.includes('ranking') ? TTL_MAP.ranking : (TTL_MAP[key] || DEFAULT_TTL);
}

/**
 * 给 tab 缓存 key 加来源前缀。
 * 切成 yande 后若沿用同一个 key，水合出来的会是上一站的列表。
 * @param {string} source
 * @param {string} key
 */
export function scopedTabKey(source, key) {
  return `${source || 'pixiv'}:${key}`;
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
          deleteTabCache(key).catch(() => { });
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
          cleanupExpired(expiredKeys).catch(() => { });
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

/**
 * Pixiv 缓存元数据 IndexedDB 存储。
 *
 * 替代原来的 JSON 文件散落在 Filesystem 中的方案：
 * - 所有元数据集中在一个 IndexedDB 数据库中
 * - 单次查询替代 N 次 readFile，消除 Capacitor plugin error 日志
 * - 图片文件仍存在 Capacitor Filesystem（DATA 或 DOCUMENTS）
 *
 * 当前 schema：作品元数据集中存储，按 state / likedAt / tags 等索引查询。
 */
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cacheDB');

const DB_NAME = 'teyvat_pixiv_cache_v2';
const DB_VERSION = 1;
const STORE = 'metadata';

let _db = null;

function openDB() {
  // 缓存命中且版本匹配，直接复用。
  if (_db && _db.version >= DB_VERSION) return Promise.resolve(_db);
  // 版本不匹配时先关闭旧连接，否则 indexedDB.open 会被阻塞。
  if (_db) { _db.close(); _db = null; }
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      _db = null;
      return reject(new Error('IndexedDB not available'));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE, { keyPath: 'cacheKey' });
      store.createIndex('illustId', 'illustId', { unique: false });
      store.createIndex('cachedAt', 'cachedAt', { unique: false });
      store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      store.createIndex('author', 'author', { unique: false });
      store.createIndex('state', 'state', { unique: false });
      store.createIndex('stateCachedAt', ['state', 'cachedAt'], { unique: false });
      store.createIndex('likedAt', 'likedAt', { unique: false });
    };
    req.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };
    req.onerror = () => {
      _db = null;
      reject(req.error);
    };
  });
}

/**
 * 获取单条缓存元数据。
 * @param {string} cacheKey
 * @returns {object|null}
 */
export async function getMeta(cacheKey) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(cacheKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    log.debug('getMeta 失败:', e?.message || e);
    return null;
  }
}

/**
 * 写入/更新缓存元数据。
 * @param {object} meta — 必须包含 cacheKey 字段
 */
export async function putMeta(meta) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(meta);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    // silent fail
    log.debug('putMeta 失败:', e?.message || e);
  }
}

/**
 * 批量写入元数据（单事务）。
 * @param {object[]} metas
 */
export async function putMetaBatch(metas) {
  if (!metas?.length) return;
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const meta of metas) {
        store.put(meta);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (e) {
    log.debug('putMetaBatch 失败:', e?.message || e);
  }
}

/**
 * 删除单条缓存元数据。
 */
export async function deleteMeta(cacheKey) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(cacheKey);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch (e) {
    log.debug('deleteMeta 失败:', e?.message || e);
  }
}

/**
 * 获取全部元数据。
 */
export async function getAllMeta() {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    log.debug('getAllMeta 失败:', e?.message || e);
    return [];
  }
}

/**
 * 分页获取按 state 过滤的缓存元数据（按 cachedAt 倒序）。
 * @param {'cached'|'saved'} filterState — 目标 state 值
 * @param {number} offset
 * @param {number} limit
 * @returns {{ items: object[], total: number }}
 */
export async function getByStatePaginated(filterState, offset = 0, limit = 50) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);

    const total = await new Promise((resolve) => {
      try {
        const req = store.index('state').count(IDBKeyRange.only(filterState));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      } catch { resolve(0); }
    });

    if (total === 0) return { items: [], total: 0 };

    // 优先使用复合索引 [state, cachedAt] 进行高效分页
    const items = await new Promise((resolve) => {
      const results = [];
      let skipped = 0;
      const idx = store.index('stateCachedAt');
      const req = idx.openCursor(
        IDBKeyRange.bound([filterState], [filterState, Number.MAX_SAFE_INTEGER]),
        'prev'
      );
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(results); return; }
        if (skipped < offset) { skipped++; cursor.continue(); return; }
        if (results.length >= limit) { resolve(results); return; }
        results.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => resolve(results);
    });

    return { items, total };
  } catch (e) {
    log.debug('getByStatePaginated 失败:', e?.message || e);
    return { items: [], total: 0 };
  }
}

/**
 * 分页获取喜欢的元数据（likedAt > 0，按 likedAt 倒序）。
 * 使用 likedAt 索引高效查询。
 * @param {number} offset
 * @param {number} limit
 * @returns {{ items: object[], total: number }}
 */
export async function getLikedMetaPaginated(offset = 0, limit = 50) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);

    // 使用 likedAt 索引计数
    let total = 0;
    if (store.indexNames.contains('likedAt')) {
      total = await new Promise((resolve) => {
        try {
          const req = store.index('likedAt').count(IDBKeyRange.lowerBound(1));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(0);
        } catch { resolve(0); }
      });
    }
    if (total === 0) return { items: [], total: 0 };

    // 按 likedAt 倒序分页
    const items = await new Promise((resolve) => {
      const results = [];
      let skipped = 0;
      const idx = store.index('likedAt');
      const req = idx.openCursor(IDBKeyRange.lowerBound(1), 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(results); return; }
        if (skipped < offset) { skipped++; cursor.continue(); return; }
        if (results.length >= limit) { resolve(results); return; }
        results.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => resolve(results);
    });

    return { items, total };
  } catch (e) {
    log.debug('getByStatePaginated 失败:', e?.message || e);
    return { items: [], total: 0 };
  }
}

/**
 * 获取同一 illustId 的所有页缓存。
 * @param {string} illustId
 * @returns {object[]}
 */
export async function getByIllustId(illustId) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const idx = tx.objectStore(STORE).index('illustId');
      const req = idx.getAll(IDBKeyRange.only(String(illustId)));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    log.debug('getByIllustId 失败:', e?.message || e);
    return [];
  }
}

/**
 * 通过标签搜索缓存。
 * @param {string} tag
 * @returns {object[]}
 */
export async function searchByTag(tag) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const idx = tx.objectStore(STORE).index('tags');
      const req = idx.getAll(IDBKeyRange.only(String(tag)));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    log.debug('searchByTag 失败:', e?.message || e);
    return [];
  }
}

/**
 * 获取缓存统计信息。
 * @returns {{ total: number, saved: number, cached: number, totalSize: number }}
 */
export async function getCacheStats() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);

    const saved = await new Promise((resolve) => {
      try {
        const req = store.index('state').count(IDBKeyRange.only('saved'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      } catch { resolve(0); }
    });

    const cached = await new Promise((resolve) => {
      try {
        const req = store.index('state').count(IDBKeyRange.only('cached'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      } catch { resolve(0); }
    });

    const total = saved + cached;

    // 总大小仍需扫描（只累加 size 字段，不返回完整记录）
    let totalSize = 0;
    if (total > 0) {
      await new Promise((resolve) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(); return; }
          if (!cursor.value.cacheKey?.startsWith('_meta_') && cursor.value.size) {
            totalSize += cursor.value.size;
          }
          cursor.continue();
        };
        req.onerror = () => resolve();
      });
    }

    return { total, saved, cached, totalSize };
  } catch (e) {
    log.debug('getCacheStats 失败:', e?.message || e);
    return { total: 0, saved: 0, cached: 0, totalSize: 0 };
  }
}

// ═══════════════════════════════════════════════
// 持久化备份（卸载不丢）
// ═══════════════════════════════════════════════

/** 导出全部元数据为 JSON 字符串 */
export async function exportDBToJSON() {
  const all = await getAllMeta();
  return JSON.stringify(all);
}

/** 从 JSON 字符串导入元数据（合并，不覆盖已有记录） */
export async function importDBFromJSON(json) {
  if (!json) return 0;
  try {
    const records = JSON.parse(json);
    if (!Array.isArray(records) || !records.length) return 0;
    let count = 0;
    for (const rec of records) {
      if (!rec.cacheKey || rec.cacheKey.startsWith('_meta_')) continue;
      const existing = await getMeta(rec.cacheKey);
      if (!existing) {
        await putMeta(rec);
        count++;
      }
    }
    return count;
  } catch (e) {
    log.debug('importDBFromJSON 失败:', e?.message || e);
    return 0;
  }
}

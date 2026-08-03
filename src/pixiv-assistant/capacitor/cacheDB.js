/**
 * Pixiv 缓存元数据 IndexedDB 存储。
 *
 * 替代原来的 JSON 文件散落在 Filesystem 中的方案：
 * - 所有元数据集中在一个 IndexedDB 数据库中
 * - 单次查询替代 N 次 readFile，消除 Capacitor plugin error 日志
 * - 图片文件仍存在 Capacitor Filesystem（DATA 或 DOCUMENTS）
 *
 * v2 新增：tags multiEntry 索引、author 索引、分页查询、缓存统计、批量写入
 */
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cacheDB');

const DB_NAME = 'teyvat_pixiv_cache';
const DB_VERSION = 10;
const STORE = 'metadata';

let _db = null;

function openDB() {
  // 缓存命中且版本匹配，直接复用
  if (_db && _db.version >= DB_VERSION) return Promise.resolve(_db);
  // 版本不匹配（升级），先关闭旧连接，否则 indexedDB.open 会被阻塞
  if (_db) { _db.close(); _db = null; }
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      _db = null;
      return reject(new Error('IndexedDB not available'));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      let store;
      if (!db.objectStoreNames.contains(STORE)) {
        store = db.createObjectStore(STORE, { keyPath: 'cacheKey' });
        store.createIndex('illustId', 'illustId', { unique: false });
        store.createIndex('saved', 'saved', { unique: false });
        store.createIndex('cachedAt', 'cachedAt', { unique: false });
      }
      // v1 → v2: 新增 tags + author 索引
      if (e.oldVersion < 2) {
        store = e.target.transaction.objectStore(STORE);
        if (!store.indexNames.contains('tags')) {
          store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
        }
        if (!store.indexNames.contains('author')) {
          store.createIndex('author', 'author', { unique: false });
        }
      }
      // v2 → v3: 重建 saved 索引
      if (e.oldVersion < 3) {
        store = e.target.transaction.objectStore(STORE);
        if (store.indexNames.contains('saved')) {
          store.deleteIndex('saved');
        }
        store.createIndex('saved', 'saved', { unique: false });
      }
      // v3 → v4: 新增复合索引 [saved, cachedAt]
      if (e.oldVersion < 4) {
        store = e.target.transaction.objectStore(STORE);
        if (!store.indexNames.contains('savedCachedAt')) {
          store.createIndex('savedCachedAt', ['saved', 'cachedAt'], { unique: false });
        }
      }
      // v4 → v5: 重建 saved 索引
      if (e.oldVersion < 5) {
        store = e.target.transaction.objectStore(STORE);
        if (store.indexNames.contains('saved')) {
          store.deleteIndex('saved');
        }
        store.createIndex('saved', 'saved', { unique: false });
      }
      // v5 → v6: saved 从 boolean 转为 number (1/0)
      if (e.oldVersion < 6) {
        store = e.target.transaction.objectStore(STORE);
        if (store.indexNames.contains('saved')) {
          store.deleteIndex('saved');
        }
        store.createIndex('saved', 'saved', { unique: false });
        store.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          const record = cursor.value;
          if (typeof record.saved === 'boolean') {
            record.saved = record.saved ? 1 : 0;
            cursor.update(record);
          }
          cursor.continue();
        };
      }
      // v6 → v7: 旧数据补充 authorName/authorAccount
      if (e.oldVersion < 7) {
        store = e.target.transaction.objectStore(STORE);
        store.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          const record = cursor.value;
          if (!record.authorName) {
            record.authorName = record.author || '';
            record.authorAccount = record.authorAccount || '';
            cursor.update(record);
          }
          cursor.continue();
        };
      }
      // v7 → v8: 迁移 ugoira_{id} cacheKey → pixiv_{id}_g0
      if (e.oldVersion < 8) {
        store = e.target.transaction.objectStore(STORE);
        const toMigrate = [];
        store.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) {
            // cursor 遍历完，在当前事务中执行迁移
            const migrationTx = e.target.transaction;
            for (const { oldKey, record, newKey } of toMigrate) {
              record.cacheKey = newKey;
              migrationTx.objectStore(STORE).put(record);
              migrationTx.objectStore(STORE).delete(oldKey);
            }
            return;
          }
          const record = cursor.value;
          if (record.cacheKey && record.cacheKey.startsWith('ugoira_')) {
            const sid = record.cacheKey.replace('ugoira_', '');
            const newKey = `pixiv_${sid}_g0`;
            toMigrate.push({ oldKey: record.cacheKey, record, newKey });
          }
          cursor.continue();
        };
      }
      // v8 → v9: saved 字段退役 → state 为唯一真相
      // - 为所有旧记录填充 state 字段
      // - saved 索引 → state 索引
      // - savedCachedAt 复合索引 → stateCachedAt 复合索引
      if (e.oldVersion < 9) {
        store = e.target.transaction.objectStore(STORE);
        // 删除旧 saved 系列索引
        if (store.indexNames.contains('saved')) {
          store.deleteIndex('saved');
        }
        if (store.indexNames.contains('savedCachedAt')) {
          store.deleteIndex('savedCachedAt');
        }
        // 创建新 state 系列索引
        if (!store.indexNames.contains('state')) {
          store.createIndex('state', 'state', { unique: false });
        }
        if (!store.indexNames.contains('stateCachedAt')) {
          store.createIndex('stateCachedAt', ['state', 'cachedAt'], { unique: false });
        }
        // 为旧记录填充 state（从 saved 字段推导）
        store.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          const record = cursor.value;
          if (!record.state) {
            record.state = record.saved ? 'saved' : 'cached';
            cursor.update(record);
          }
          cursor.continue();
        };
      }
      // v9 → v10: 新增 likedAt 索引
      if (e.oldVersion < 10) {
        store = e.target.transaction.objectStore(STORE);
        if (!store.indexNames.contains('likedAt')) {
          store.createIndex('likedAt', 'likedAt', { unique: false });
        }
        // 为旧记录填充 likedAt（从 flags.favorite 推导）
        store.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          const record = cursor.value;
          if (record.likedAt === undefined) {
            record.likedAt = record.flags?.favorite ? Date.now() : 0;
            cursor.update(record);
          }
          cursor.continue();
        };
      }
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
  const diag = {};
  try {
    const db = await openDB();
    diag.dbVersion = db.version;
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    diag.indexNames = Array.from(store.indexNames);

    // 使用 state 索引计数
    let total = await new Promise((resolve) => {
      if (!store.indexNames.contains('state')) { resolve(null); return; }
      try {
        const req = store.index('state').count(IDBKeyRange.only(filterState));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    diag.indexCountResult = total;

    if (total === null) {
      // fallback: 全表扫描
      const all = await new Promise((resolve) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
      const filtered = all.filter(r => r.state === filterState
        // 兼容旧记录：无 state 时从 saved 推导
        || (!r.state && (filterState === 'saved' ? (r.saved === 1 || r.saved === true) : !r.saved)));
      filtered.sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
      total = filtered.length;
      diag.fallback = 'getAll';
      diag.allCount = all.length;
      if (total === 0) return { items: [], total: 0, _diag: diag };
      return { items: filtered.slice(offset, offset + limit), total, _diag: diag };
    }

    if (total === 0) return { items: [], total: 0, _diag: diag };

    // 优先使用复合索引 [state, cachedAt] 进行高效分页
    const items = await new Promise((resolve) => {
      const results = [];
      let skipped = 0;

      if (store.indexNames.contains('stateCachedAt')) {
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
      } else if (store.indexNames.contains('cachedAt')) {
        // fallback: 使用 cachedAt 索引，手动过滤 state
        const idx = store.index('cachedAt');
        const req = idx.openCursor(null, 'prev');
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(results); return; }
          const s = cursor.value.state;
          // 兼容旧记录
          const isMatch = s === filterState
            || (!s && (filterState === 'saved' ? (cursor.value.saved === 1 || cursor.value.saved === true) : !cursor.value.saved));
          if (!isMatch) { cursor.continue(); return; }
          if (skipped < offset) { skipped++; cursor.continue(); return; }
          if (results.length >= limit) { resolve(results); return; }
          results.push(cursor.value);
          cursor.continue();
        };
        req.onerror = () => resolve(results);
      } else {
        resolve([]);
      }
    });

    diag.total = total;
    diag.returned = items.length;
    return { items, total, _diag: diag };
  } catch (e) {
    diag.error = e?.message || String(e);
    return { items: [], total: 0, _diag: diag };
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
 * @returns {{ total: number, saved: number, auto: number, totalSize: number }}
 */
export async function getCacheStats() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);

    // 使用索引计数代替全表扫描
    const total = await new Promise((resolve) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });

    const saved = await new Promise((resolve) => {
      if (!store.indexNames.contains('state')) { resolve(0); return; }
      try {
        const req = store.index('state').count(IDBKeyRange.only('saved'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      } catch { resolve(0); }
    });

    // 总大小仍需扫描（只累加 size 字段，不返回完整记录）
    let totalSize = 0;
    if (total > 0) {
      await new Promise((resolve) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(); return; }
          if (cursor.value.size) totalSize += cursor.value.size;
          cursor.continue();
        };
        req.onerror = () => resolve();
      });
    }

    return { total, saved, auto: total - saved, totalSize };
  } catch (e) {
    log.debug('getCacheStats 失败:', e?.message || e);
    return { total: 0, saved: 0, auto: 0, totalSize: 0 };
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

// ═══════════════════════════════════════════════
// 一次性清理脚本：去掉标题中的页码后缀 (1/3) 等
// ═══════════════════════════════════════════════
(async function cleanTitles() {
  try {
    if (typeof indexedDB === 'undefined') return;
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const all = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    let count = 0;
    for (const rec of all) {
      if (!rec.title || rec.cacheKey?.startsWith('_meta_')) continue;
      const cleaned = rec.title.replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
      if (cleaned && cleaned !== rec.title) {
        rec.title = cleaned;
        store.put(rec);
        count++;
      }
    }
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
    log.info(`[cleanTitles] 已清理 ${count} 条标题页码后缀`);
  } catch (e) {
    log.warn('[cleanTitles] 失败:', e.message);
  }
})();

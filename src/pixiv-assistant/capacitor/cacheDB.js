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
import { entityKeyOf, sourceOfId } from '../core/utils.js';

const log = createLogger('cacheDB');

const DB_NAME = 'teyvat_pixiv_cache_v2';
const DB_VERSION = 2;
const STORE = 'metadata';
/** 升级被旧连接阻塞时的宽限期：超过即放弃本次打开（缓存降级为直连），避免 promise 永远挂着 */
const BLOCKED_GRACE_MS = 3000;

let _db = null;
let _dbPromise = null;

/**
 * v1 → v2：把实体的 key 改回「从 illustId 派生的真来源」。
 *
 * v1 期间 KNOWN_SOURCES 漏登记了 6 个来源（tbib / sakugabooru / zerochan / hypnohub / xbooru /
 * safebooru-donmai），sourceOfId 把它们判回 pixiv，于是这些来源的记录被写成
 * `pixiv:zerochan_12345:0`。补全词表后 makeId 会算出 `zerochan:zerochan_12345:0`，
 * 老记录就再也 find 不到了 —— 不迁移的话用户已有的喜欢/已保存会「消失」，
 * 重新点一次还会在喜欢页出现同作品两条记录。
 *
 * 判据是「key ≠ 从 illustId 派生的 key」，已经正确的记录命中不了，重跑安全；
 * 整个改写发生在 versionchange 事务里，要么全成要么全不成，不会留下半迁移状态。
 */
function migrateEntityKeys(store) {
  const req = store.getAll();
  req.onsuccess = () => {
    const all = req.result || [];
    let moved = 0;
    for (const rec of all) {
      // 备份用的标记记录（`_meta_*`）不是实体，没有 illustId
      if (!rec?.illustId || typeof rec.cacheKey !== 'string' || rec.cacheKey.startsWith('_meta_')) continue;
      const want = entityKeyOf(rec.illustId, rec.pageIndex ?? 0);
      if (rec.cacheKey === want) continue;
      store.put({ ...rec, cacheKey: want, source: sourceOfId(rec.illustId) });
      store.delete(rec.cacheKey);
      moved += 1;
    }
    if (moved) log.info(`实体 key 迁移（v1→v2）：改写 ${moved} 条 / 共 ${all.length} 条`);
  };
}

function openDB() {
  // 缓存命中且版本匹配，直接复用。
  if (_db && _db.version >= DB_VERSION) return Promise.resolve(_db);
  // 版本不匹配时先关闭旧连接，否则 indexedDB.open 会被阻塞。
  if (_db) { _db.close(); _db = null; }
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      _db = null;
      return reject(new Error('IndexedDB not available'));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // 幂等建库：老库升级（DB_VERSION 变大）时该 store 已存在，
      // 无条件 createObjectStore 会抛 ConstraintError 导致整个 open 失败、
      // 后续读取静默变空（收藏/已保存标记全部消失）
      const store = db.objectStoreNames.contains(STORE)
        ? req.transaction.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: 'cacheKey' });
      const ensureIndex = (name, keyPath, options) => {
        if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
      };
      ensureIndex('illustId', 'illustId', { unique: false });
      ensureIndex('cachedAt', 'cachedAt', { unique: false });
      ensureIndex('tags', 'tags', { unique: false, multiEntry: true });
      ensureIndex('author', 'author', { unique: false });
      ensureIndex('state', 'state', { unique: false });
      ensureIndex('stateCachedAt', ['state', 'cachedAt'], { unique: false });
      ensureIndex('likedAt', 'likedAt', { unique: false });

      // 只在「老库升到 v2」时跑；全新装库（oldVersion 0）里没有记录，跑不跑都一样
      if (e.oldVersion > 0 && e.oldVersion < 2) migrateEntityKeys(store);
    };
    let settled = false;
    const settle = (fn, val) => { if (settled) return; settled = true; fn(val); };
    req.onsuccess = (e) => {
      // 已过宽限期、按失败处理后才到达的迟到连接：关掉它，
      // 别让它占着旧版本把下一次升级同样堵死
      if (settled) { e.target.result.close(); return; }
      _db = e.target.result;
      settle(resolve, _db);
    };
    req.onerror = () => {
      // open 失败会让后续所有读写静默返回空值（数据"凭空消失"），必须留下明确日志
      log.warn('IndexedDB 打开失败:', req.error?.message || req.error);
      _db = null;
      settle(reject, req.error);
    };
    // 被旧连接阻塞时 open 既不 success 也不 error，promise 会永远挂着：
    // 水合 await 永不返回、首屏一直转圈。宽限几秒后按失败处理，让上层降级走网络。
    req.onblocked = () => {
      log.warn('IndexedDB 升级被其他连接阻塞（可能有旧页面未关闭），3 秒后放弃');
      setTimeout(() => {
        if (settled) return;
        log.warn('IndexedDB 仍被阻塞，本次打开按失败处理，读写走降级路径');
        _db = null;
        settle(reject, new Error('IndexedDB open blocked'));
      }, BLOCKED_GRACE_MS);
    };
  }).finally(() => { _dbPromise = null; });
  return _dbPromise;
}

/**
 * 获取单条缓存元数据。
 * @param {string} cacheKey
 * @returns {object|null}
 */
export async function getMeta(cacheKey) {
  // open / 事务失败均上抛：调用方（repository/hiddenWorks）可区分「记录不存在」
  // 与「存储不可用」，后者静默返回 null 会把数据故障伪装成「没这条记录」。
  // 已复核全部调用方均有 catch / .catch 兜底（回滚乐观更新或按尽力而为处理）。
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(cacheKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
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
    // 写失败必须上抛（磁盘满/事务 abort）：喜欢/保存据此返回失败并回滚 UI 乐观更新，
    // 静默吞掉会出现「红心亮着、重启后喜欢消失」的假持久化。
    // 确实尽力而为的调用方（如 hiddenWorks）自己 .catch 即可。
    log.warn('putMeta 失败:', e?.message || e);
    throw e;
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
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const meta of metas) {
        store.put(meta);
      }
      tx.oncomplete = () => resolve();
      // 失败必须上抛：调用方（恢复备份/相册对账）在 catch 里记日志并放弃
      // 「已恢复 N 条」的成功结论，静默 resolve 会虚报恢复成功
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    log.warn('putMetaBatch 失败:', e?.message || e);
    throw e;
  }
}

/**
 * 获取全部元数据。
 */
export async function getAllMeta() {
  // open 失败上抛：调用方自行决定降级（metaBackup 已 .catch(() => [])），
  // 这里静默返回 [] 会让启动扫描/备份把「存储坏了」当成「一条记录都没有」
  const db = await openDB();
  return await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

/**
 * 分页获取喜欢的元数据（likedAt > 0，按 likedAt 倒序）。
 * 使用 likedAt 索引高效查询。
 * @param {number} offset
 * @param {number} limit
 * @returns {{ items: object[], total: number }}
 */
export async function getLikedMetaPaginated(offset = 0, limit = 50) {
  // open 失败上抛：喜欢页据此显示「加载失败」而不是把坏存储当成「收藏为空」
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
}

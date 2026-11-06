/**
 * Pixiv Repository — Entity ↔ IndexedDB 之间的映射器。
 *
 * 上层（StorageService）只和 Entity 打交道，不知道 IndexedDB 的存在。
 * 切换存储（IndexedDB → SQLite）只需改这个文件。
 */
import { PixivEntity } from './entity.js';
import { getMeta, putMeta, getAllMeta, getLikedMetaPaginated } from './cacheDB.js';

/**
 * 把 meta 里的展示字段补进 record 的空位（不覆盖已有值）。
 * toggleLike / like / fillMeta 共用一份回填逻辑，字段集取并集：
 * 缺哪个补哪个，多传不认识的字段忽略。
 * @returns {boolean} 是否有字段被补上
 */
function applyBackfill(record, meta = {}) {
  let changed = false;
  const fill = (key, val) => {
    if (val && !record[key]) { record[key] = val; changed = true; }
  };
  fill('thumbnailUrl', meta.thumbnailUrl);
  fill('title', meta.title);
  fill('authorId', meta.authorId);
  fill('authorAvatar', meta.authorAvatar);
  fill('type', meta.type);
  fill('pixivUrl', meta.pixivUrl);
  fill('pageCount', meta.pageCount);
  // author / authorName 成对处理：任一缺失时同时补齐，避免只剩一半
  if ((meta.authorName || meta.author) && !record.authorName) {
    record.authorName = meta.authorName || meta.author || '';
    record.author = meta.author || meta.authorName || '';
    changed = true;
  }
  const tags = Array.isArray(meta.tags) ? meta.tags.filter(Boolean) : [];
  if (tags.length > 0 && !(Array.isArray(record.tags) && record.tags.length > 0)) {
    record.tags = tags;
    changed = true;
  }
  return changed;
}

/**
 * 点喜欢时记录尚不存在 → 建轻记录（只含展示所需的最小字段，无文件）。
 * @param {string} id — entity key
 * @param {object} meta — 展示元数据
 * @param {number} now — likedAt 时间戳
 */
function buildLightRecord(id, meta, now) {
  const { source, illustId, pageIndex } = PixivEntity.parseId(id);
  return {
    cacheKey: id,
    illustId,
    source,
    pageIndex,
    state: 'cached',
    likedAt: now,
    cachedAt: now,
    type: meta.type || 'image',
    title: meta.title || '',
    author: meta.author || '',
    authorName: meta.authorName || meta.author || '',
    authorAccount: meta.authorAccount || '',
    authorAvatar: meta.authorAvatar || '',
    authorId: meta.authorId || '',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    thumbnailUrl: meta.thumbnailUrl || '',
    pixivUrl: meta.pixivUrl || '',
    webUrl: meta.webUrl || meta.pixivUrl || '',
    pageCount: meta.pageCount || 0,
    width: meta.width || 0,
    height: meta.height || 0,
  };
}

export class PixivRepository {
  /**
   * 保存 entity（新建或更新）。
   * @param {PixivEntity} entity
   */
  async save(entity) {
    await putMeta(entity.toRecord());
  }

  /**
   * 按 id 查找。
   * @param {string} id — entity key ({source}:{illustId}:{pageIndex})
   * @returns {PixivEntity|null}
   */
  async find(id) {
    const record = await getMeta(id);
    return PixivEntity.fromRecord(record);
  }

  /**
   * 按喜欢状态分页查询。
   * @param {number} offset
   * @param {number} limit
   * @returns {{ items: PixivEntity[], total: number }}
   */
  async listLiked(offset = 0, limit = 50) {
    const result = await getLikedMetaPaginated(offset, limit);
    return {
      items: (result.items || []).map(r => PixivEntity.fromRecord(r)).filter(Boolean),
      total: result.total || 0,
    };
  }

  /**
   * 修改状态（cached → saved）。
   * @param {string} id
   * @param {'cached'|'saved'} newState
   */
  async changeState(id, newState) {
    const record = await getMeta(id);
    if (!record) throw Object.assign(new Error(`entity_not_found: ${id}`), { code: 'entity_not_found' });
    record.state = newState;
    await putMeta(record);
  }

  /**
   * 回填展示元数据（浏览时把完整缩略图 URL / 标题 / 作者 / tags / pageCount 写回已保存/喜欢的记录）。
   * 幂等：只填充当前为空的字段，不覆盖已有值。
   * @param {string} id
   * @param {object} meta — { thumbnailUrl?, title?, author?, authorName?, authorId?, type?, tags?, pixivUrl?, pageCount? }
   * @returns {Promise<{updated: boolean}>}
   */
  async fillMeta(id, meta = {}) {
    const record = await getMeta(id);
    if (!record) return { updated: false };
    const changed = applyBackfill(record, meta);
    if (changed) {
      try {
        await putMeta(record);
      } catch {
        // 尽力而为：浏览时的回填失败不影响主流程，下次浏览会再试
        return { updated: false };
      }
    }
    return { updated: changed };
  }

  /**
   * 切换喜欢状态。
   * @param {string} id
   * @param {object} [meta] — 展示元数据（缩略图/标题/作者/总页数等），轻记录创建时写入，
   *                          已有记录缺字段时回填，供「喜欢」页网格展示。
   * @returns {Promise<{success: boolean, liked?: boolean, likedAt?: number, error?: string}>}
   */
  async toggleLike(id, meta = {}) {
    const record = await getMeta(id);
    const now = Date.now();
    if (!record) {
      try {
        await putMeta(buildLightRecord(id, meta, now));
      } catch {
        return { success: false, error: 'meta_write_failed' };
      }
      return { success: true, liked: true, likedAt: now };
    }

    const wasLiked = (record.likedAt || 0) > 0;
    record.likedAt = wasLiked ? 0 : now;
    applyBackfill(record, meta);
    try {
      await putMeta(record);
    } catch {
      return { success: false, error: 'meta_write_failed' };
    }
    return { success: true, liked: !wasLiked, likedAt: record.likedAt };
  }

  /**
   * 幂等设为喜欢。
   * @param {string} id
   * @param {object} [meta]
   * @returns {Promise<{success: boolean, liked?: boolean, likedAt?: number, idempotent?: boolean, error?: string}>}
   */
  async like(id, meta = {}) {
    const record = await getMeta(id);
    const now = Date.now();
    if (!record) {
      try {
        await putMeta(buildLightRecord(id, meta, now));
      } catch {
        return { success: false, error: 'meta_write_failed' };
      }
      return { success: true, liked: true, likedAt: now };
    }

    const alreadyLiked = (record.likedAt || 0) > 0;
    if (!alreadyLiked) record.likedAt = now;
    applyBackfill(record, meta);
    try {
      await putMeta(record);
    } catch {
      return { success: false, error: 'meta_write_failed' };
    }
    return { success: true, liked: true, likedAt: record.likedAt, idempotent: alreadyLiked };
  }

  /**
   * 幂等取消喜欢（保留记录与已保存状态，仅清 likedAt）。
   * @param {string} id
   * @returns {Promise<{success: boolean, unliked?: boolean, likedAt?: number, error?: string}>}
   */
  async unlike(id) {
    const record = await getMeta(id);
    if (!record) return { success: true, unliked: false, likedAt: 0 };
    const wasLiked = (record.likedAt || 0) > 0;
    if (wasLiked) {
      record.likedAt = 0;
      try {
        await putMeta(record);
      } catch {
        return { success: false, error: 'meta_write_failed' };
      }
    }
    return { success: true, unliked: wasLiked, likedAt: 0 };
  }

  /**
   * 获取所有 entity（全量扫描，仅用于迁移/清理）。
   * @returns {PixivEntity[]}
   */
  async getAll() {
    const records = await getAllMeta();
    return records.map(r => PixivEntity.fromRecord(r)).filter(Boolean);
  }
}

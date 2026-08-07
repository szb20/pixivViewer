/**
 * Pixiv Repository — Entity ↔ IndexedDB 之间的映射器。
 *
 * 上层（StorageService / TransitionEngine）只和 Entity 打交道，
 * 不知道 IndexedDB 的存在。
 * 切换存储（IndexedDB → SQLite）只需改这个文件。
 */
import { PixivEntity } from './entity.js';
import {
  getMeta, putMeta, putMetaBatch, deleteMeta,
  getAllMeta, getByStatePaginated, getLikedMetaPaginated,
  getByIllustId, getCacheStats,
} from './cacheDB.js';

export class PixivRepository {
  /**
   * 保存 entity（新建或更新）。
   * @param {PixivEntity} entity
   */
  async save(entity) {
    const record = entity.toRecord();
    await putMeta(record);
  }

  /**
   * 批量保存。
   * @param {PixivEntity[]} entities
   */
  async saveBatch(entities) {
    const records = entities.map(e => e.toRecord());
    await putMetaBatch(records);
  }

  /**
   * 按 id 查找。
   * @param {string} id — entity key (pixiv:{illustId}:{pageIndex})
   * @returns {PixivEntity|null}
   */
  async find(id) {
    const record = await getMeta(id);
    return PixivEntity.fromRecord(record);
  }

  /**
   * 按 illustId 查找所有页。
   * @param {string} illustId
   * @returns {PixivEntity[]}
   */
  async findByIllustId(illustId) {
    const records = await getByIllustId(illustId);
    return records.map(r => PixivEntity.fromRecord(r)).filter(Boolean);
  }

  /**
   * 按状态分页查询。
   * @param {'cached'|'saved'} state
   * @param {number} offset
   * @param {number} limit
   * @returns {{ items: PixivEntity[], total: number }}
   */
  async listByState(state, offset = 0, limit = 50) {
    const result = await getByStatePaginated(state, offset, limit);
    return {
      items: (result.items || []).map(r => PixivEntity.fromRecord(r)).filter(Boolean),
      total: result.total || 0,
    };
  }

  /**
   * 按喜欢状态分页查询（likedAt > 0）。
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
   * 删除 entity。
   * @param {string} id
   */
  async delete(id) {
    await deleteMeta(id);
  }

  /**
   * 修改状态（TransitionEngine 专用）。
   * 直接更新 state 字段，不加载整个 entity。
   * @param {string} id
   * @param {'cached'|'saved'} newState
   */
  async changeState(id, newState) {
    const record = await getMeta(id);
    if (!record) throw new Error(`entity_not_found: ${id}`);
    record.state = newState;
    await putMeta(record);
  }

  /**
   * 更新 flags。
   * @param {string} id
   * @param {object} flags — 要合并的 flags
   */
  async updateFlags(id, flags) {
    const record = await getMeta(id);
    if (!record) return;
    record.flags = { ...(record.flags || {}), ...flags };
    await putMeta(record);
  }

  /**
   * 回填展示元数据（浏览时把完整缩略图 URL / 标题 / 作者 / tags 写回已保存/喜欢的记录）。
   * 幂等：只填充当前为空的字段，不覆盖已有值。
   * @param {string} id
   * @param {object} meta — { thumbnailUrl?, title?, author?, authorName?, authorId?, type?, tags? }
   * @returns {Promise<{updated: boolean}>}
   */
  async fillMeta(id, meta = {}) {
    const record = await getMeta(id);
    if (!record) return { updated: false };
    let changed = false;
    for (const key of ['thumbnailUrl', 'title', 'author', 'authorName', 'authorId', 'type']) {
      const val = meta[key];
      if (val && !record[key]) { record[key] = val; changed = true; }
    }
    const tags = Array.isArray(meta.tags) ? meta.tags.filter(Boolean) : [];
    if (tags.length > 0 && !(Array.isArray(record.tags) && record.tags.length > 0)) {
      record.tags = tags;
      changed = true;
    }
    if (changed) await putMeta(record);
    return { updated: changed };
  }

  /**
   * 回填缺失的展示元数据（浏览详情/启动迁移时把缩略图/标题/作者写回）。
   * 只补空字段，不覆盖已有值。
   * @param {string} id
   * @param {object} [meta]
   * @returns {Promise<{updated: boolean}>}
   */
  async backfillMeta(id, meta = {}) {
    const record = await getMeta(id);
    if (!record) return { updated: false };
    let changed = false;
    if (meta.thumbnailUrl && !record.thumbnailUrl) { record.thumbnailUrl = meta.thumbnailUrl; changed = true; }
    if (meta.title && !record.title) { record.title = meta.title; changed = true; }
    if ((meta.authorName || meta.author) && !record.authorName) {
      record.authorName = meta.authorName || meta.author || '';
      record.author = meta.author || meta.authorName || '';
      changed = true;
    }
    if (meta.authorId && !record.authorId) { record.authorId = meta.authorId; changed = true; }
    if (meta.pixivUrl && !record.pixivUrl) { record.pixivUrl = meta.pixivUrl; changed = true; }
    if (meta.pageCount && !record.pageCount) { record.pageCount = meta.pageCount; changed = true; }
    if (changed) await putMeta(record);
    return { updated: changed };
  }

  /**
   * 切换喜欢状态。
   * @param {string} id
   * @param {object} [meta] — 展示元数据（缩略图/标题/作者/总页数等），轻记录创建时写入，
   *                          已有记录缺字段时回填，供「喜欢」页网格展示。
   * @returns {Promise<{success: boolean, liked: boolean, likedAt: number}>}
   */
  async toggleLike(id, meta = {}) {
    const record = await getMeta(id);
    if (!record) {
      // 不存在 → 建轻记录
      const parts = id.replace('pixiv:', '').split(':');
      const illustId = parts[0];
      const pageIndex = parseInt(parts[1], 10) || 0;
      const now = Date.now();
      const lightRecord = {
        cacheKey: id,
        illustId,
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
        pageCount: meta.pageCount || 0,
        width: meta.width || 0,
        height: meta.height || 0,
      };
      await putMeta(lightRecord);
      return { success: true, liked: true, likedAt: now };
    }

    const wasLiked = (record.likedAt || 0) > 0;
    record.likedAt = wasLiked ? 0 : Date.now();
    // 旧轻记录升级：回填缺失的展示元数据
    if (meta.thumbnailUrl && !record.thumbnailUrl) record.thumbnailUrl = meta.thumbnailUrl;
    if (meta.title && !record.title) record.title = meta.title;
    if ((meta.authorName || meta.author) && !record.authorName) {
      record.authorName = meta.authorName || meta.author || '';
      record.author = meta.author || meta.authorName || '';
    }
    if (meta.authorId && !record.authorId) record.authorId = meta.authorId;
    if (meta.authorAvatar && !record.authorAvatar) record.authorAvatar = meta.authorAvatar;
    if (meta.type && !record.type) record.type = meta.type;
    if (Array.isArray(meta.tags) && meta.tags.length && !record.tags?.length) record.tags = meta.tags;
    if (meta.pixivUrl && !record.pixivUrl) record.pixivUrl = meta.pixivUrl;
    if (meta.pageCount && !record.pageCount) record.pageCount = meta.pageCount;
    await putMeta(record);
    return { success: true, liked: !wasLiked, likedAt: record.likedAt };
  }

  /**
   * 幂等设为喜欢。
   * @param {string} id
   * @param {object} [meta]
   * @returns {Promise<{success: boolean, liked: true, likedAt: number, idempotent?: boolean}>}
   */
  async like(id, meta = {}) {
    const record = await getMeta(id);
    const now = Date.now();
    if (!record) {
      const parts = id.replace('pixiv:', '').split(':');
      const illustId = parts[0];
      const pageIndex = parseInt(parts[1], 10) || 0;
      const lightRecord = {
        cacheKey: id,
        illustId,
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
        pageCount: meta.pageCount || 0,
        width: meta.width || 0,
        height: meta.height || 0,
      };
      await putMeta(lightRecord);
      return { success: true, liked: true, likedAt: now };
    }

    const alreadyLiked = (record.likedAt || 0) > 0;
    if (!alreadyLiked) record.likedAt = now;
    if (meta.thumbnailUrl && !record.thumbnailUrl) record.thumbnailUrl = meta.thumbnailUrl;
    if (meta.title && !record.title) record.title = meta.title;
    if ((meta.authorName || meta.author) && !record.authorName) {
      record.authorName = meta.authorName || meta.author || '';
      record.author = meta.author || meta.authorName || '';
    }
    if (meta.authorId && !record.authorId) record.authorId = meta.authorId;
    if (meta.authorAvatar && !record.authorAvatar) record.authorAvatar = meta.authorAvatar;
    if (meta.type && !record.type) record.type = meta.type;
    if (Array.isArray(meta.tags) && meta.tags.length && !record.tags?.length) record.tags = meta.tags;
    if (meta.pixivUrl && !record.pixivUrl) record.pixivUrl = meta.pixivUrl;
    if (meta.pageCount && !record.pageCount) record.pageCount = meta.pageCount;
    await putMeta(record);
    return { success: true, liked: true, likedAt: record.likedAt, idempotent: alreadyLiked };
  }

  /**
   * 统计信息。
   * @returns {{ total: number, saved: number, cached: number, totalSize: number }}
   */
  async stats() {
    return await getCacheStats();
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

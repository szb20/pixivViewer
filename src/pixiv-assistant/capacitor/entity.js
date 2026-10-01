/**
 * Pixiv 实体 — 全系统统一数据模型。
 *
 * 所有层（StorageService / TransitionEngine / FileStore / Repository）
 * 都用这个类通信，不直接操作 IndexedDB 的原始记录。
 *
 * Key 格式：{source}:{illustId}:{pageIndex}（pixiv 的 source 段即 'pixiv'）
 * 状态：cached / saved（无 deleted 状态）
 * 类型：image / gif（通过 type 字段区分，不靠 key 后缀）
 */
import { sourceOfId, DEFAULT_SOURCE } from '../core/utils.js';

export class PixivEntity {
  /**
   * @param {object} data
   * @param {string}  data.id             — '{source}:{illustId}:{pageIndex}'
   * @param {string}  data.illustId       — 全局唯一 id（pixiv 裸数字，其余 {source}_{站点id}）
   * @param {string}  [data.source]       — 来源；缺省从 illustId 推导
   * @param {number}  [data.pageIndex=0]
   * @param {'image'|'gif'} [data.type='image']
   * @param {'cached'|'saved'} [data.state='cached']
   * @param {object}  [data.flags={}]     — { favorite, syncing, broken, cloud }
   * @param {string}  [data.fileName='']
   * @param {string}  [data.title='']
   * @param {string}  [data.author='']
   * @param {string}  [data.authorName='']
   * @param {string}  [data.authorAccount='']
   * @param {string}  [data.authorAvatar='']
   * @param {string}  [data.authorId='']
   * @param {string[]} [data.tags=[]]
   * @param {number}  [data.cachedAt]
   * @param {number}  [data.pageCount]
   * @param {number}  [data.size=0]
   * @param {Array}   [data.frames]
   * @param {number}  [data.frameCount]
   * @param {string}  [data.pixivUrl='']
   * @param {string}  [data.originalUrl='']
   * @param {string}  [data.thumbnailUrl='']
   * @param {string}  [data.mediumUrl='']
   * @param {string}  [data._contentUri]
   * @param {number}  [data.likedAt=0]
   */
  constructor(data) {
    this.id = data.id;
    this.illustId = data.illustId;
    // source 一律从 illustId 派生（data.source 只是提示），两者不可能长期不一致
    this.source = data.source || sourceOfId(data.illustId);
    this.pageIndex = data.pageIndex ?? 0;
    this.type = data.type || 'image';
    this.state = data.state || 'cached';
    this.flags = data.flags ?? {};
    this.fileName = data.fileName || '';
    this.title = data.title || '';
    this.author = data.author || '';
    this.authorName = data.authorName || data.author || '';
    this.authorAccount = data.authorAccount || '';
    this.authorAvatar = data.authorAvatar || '';
    this.authorId = data.authorId || '';
    this.tags = data.tags || [];
    this.cachedAt = data.cachedAt ?? Date.now();
    this.pageCount = data.pageCount || 0;
    this.size = data.size || 0;
    this.frames = data.frames;
    this.frameCount = data.frameCount;
    this.pixivUrl = data.pixivUrl || '';
    // 作品在原站点的网页地址（跨来源用；pixiv 老记录由 pixivUrl 兜底）
    this.webUrl = data.webUrl || data.pixivUrl || '';
    this.originalUrl = data.originalUrl || '';
    this.thumbnailUrl = data.thumbnailUrl || '';
    this.mediumUrl = data.mediumUrl || '';
    this._contentUri = data._contentUri;
    this.likedAt = data.likedAt ?? 0;
  }

  get isGif() { return this.type === 'gif'; }
  get isCached() { return this.state === 'cached'; }
  get isSaved() { return this.state === 'saved'; }
  get isLiked() { return this.likedAt > 0; }

  /** 生成新状态的 entity（不可变风格） */
  withState(newState) {
    return new PixivEntity({ ...this, state: newState });
  }

  /**
   * 统一 entity key 生成。
   *
   * source 段从 illustId 派生，不单独传参 —— 这样"来源"只有一个写入点，
   * 不会出现某个调用点漏传 source 而静默写进 pixiv 命名空间的情况。
   * pixiv 的 illustId 是裸数字，输出与历史格式 `pixiv:{id}:{page}` 逐字节一致。
   */
  static makeId(illustId, pageIndex = 0) {
    return `${sourceOfId(illustId)}:${illustId}:${pageIndex}`;
  }

  /** 解析 entity key（makeId 的逆运算）。畸形输入按 pixiv 兜底，不抛错。 */
  static parseId(id) {
    const s = String(id ?? '');
    const i = s.indexOf(':');
    const j = s.lastIndexOf(':');
    if (i < 0 || j <= i) return { source: DEFAULT_SOURCE, illustId: s, pageIndex: 0 };
    return {
      source: s.slice(0, i),
      illustId: s.slice(i + 1, j),
      pageIndex: parseInt(s.slice(j + 1), 10) || 0,
    };
  }

  /** 从原始 DB record 创建 */
  static fromRecord(record) {
    if (!record?.cacheKey || record.cacheKey.startsWith('_meta_') || !record.illustId) return null;

    return new PixivEntity({
      id: record.cacheKey,
      illustId: record.illustId,
      // 老记录没有 source 字段 → 从 illustId 派生（pixiv 老记录即得 'pixiv'）
      source: record.source || sourceOfId(record.illustId),
      pageIndex: record.pageIndex ?? 0,
      type: record.type || 'image',
      state: record.state || 'cached',
      flags: record.flags || {},
      fileName: record.fileName || '',
      title: record.title || '',
      author: record.author || '',
      authorName: record.authorName || record.author || '',
      authorAccount: record.authorAccount || '',
      authorAvatar: record.authorAvatar || '',
      authorId: record.authorId || '',
      tags: record.tags || [],
      cachedAt: record.cachedAt || Date.now(),
      pageCount: record.pageCount || 0,
      size: record.size || 0,
      frames: record.frames,
      frameCount: record.frameCount,
      pixivUrl: record.pixivUrl || '',
      webUrl: record.webUrl || record.pixivUrl || '',
      originalUrl: record.originalUrl || '',
      thumbnailUrl: record.thumbnailUrl || '',
      mediumUrl: record.mediumUrl || '',
      _contentUri: record._contentUri,
      likedAt: record.likedAt ?? 0,
    });
  }

  /** 转为 DB record（写入 IndexedDB 用） */
  toRecord() {
    return {
      cacheKey: this.id,
      illustId: this.illustId,
      source: this.source,
      pageIndex: this.pageIndex,
      type: this.type,
      state: this.state,
      flags: this.flags,
      fileName: this.fileName,
      title: this.title,
      author: this.author,
      authorName: this.authorName,
      authorAccount: this.authorAccount,
      authorAvatar: this.authorAvatar,
      authorId: this.authorId,
      tags: this.tags,
      cachedAt: this.cachedAt,
      pageCount: this.pageCount,
      size: this.size,
      frames: this.frames,
      frameCount: this.frameCount,
      pixivUrl: this.pixivUrl,
      webUrl: this.webUrl,
      originalUrl: this.originalUrl,
      thumbnailUrl: this.thumbnailUrl,
      mediumUrl: this.mediumUrl,
      _contentUri: this._contentUri,
      likedAt: this.likedAt,
    };
  }
}
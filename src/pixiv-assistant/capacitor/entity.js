/**
 * Pixiv 实体 — 全系统统一数据模型。
 *
 * 所有层（StorageService / TransitionEngine / FileStore / Repository）
 * 都用这个类通信，不直接操作 IndexedDB 的原始记录。
 *
 * Key 格式：pixiv:{illustId}:{pageIndex}
 * 状态：cached / saved（无 deleted 状态）
 * 类型：image / gif（通过 type 字段区分，不靠 key 后缀）
 */
export class PixivEntity {
  /**
   * @param {object} data
   * @param {string}  data.id             — 'pixiv:{illustId}:{pageIndex}'
   * @param {string}  data.illustId
   * @param {number}  [data.pageIndex=0]
   * @param {'image'|'gif'} [data.type='image']
   * @param {'cached'|'saved'} [data.state='cached']
   * @param {object}  [data.flags={}]     — { favorite, syncing, broken, cloud }
   * @param {string}  [data.fileName='']
   * @param {string}  [data.title='']
   * @param {string}  [data.author='']
   * @param {string}  [data.authorName='']
   * @param {string}  [data.authorAccount='']
   * @param {string}  [data.authorId='']
   * @param {string[]} [data.tags=[]]
   * @param {number}  [data.cachedAt]
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
    this.pageIndex = data.pageIndex ?? 0;
    this.type = data.type || 'image';
    this.state = data.state || 'cached';
    this.flags = data.flags ?? {};
    this.fileName = data.fileName || '';
    this.title = data.title || '';
    this.author = data.author || '';
    this.authorName = data.authorName || data.author || '';
    this.authorAccount = data.authorAccount || '';
    this.authorId = data.authorId || '';
    this.tags = data.tags || [];
    this.cachedAt = data.cachedAt ?? Date.now();
    this.size = data.size || 0;
    this.frames = data.frames;
    this.frameCount = data.frameCount;
    this.pixivUrl = data.pixivUrl || '';
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

  /** 合并 flags */
  withFlags(flags) {
    return new PixivEntity({ ...this, flags: { ...this.flags, ...flags } });
  }

  /** 统一 entity key 生成 */
  static makeId(illustId, pageIndex = 0) {
    return `pixiv:${illustId}:${pageIndex}`;
  }

  /** 从原始 DB record 创建（兼容旧格式） */
  static fromRecord(record) {
    if (!record) return null;

    // 兼容旧格式：saved: 0|1 → state
    let state = record.state;
    if (!state) {
      state = record.saved ? 'saved' : 'cached';
    }

    // 兼容旧格式：从 cacheKey 推断 type
    let type = record.type;
    if (!type) {
      type = (record.cacheKey?.includes('_g0') || record.cacheKey?.startsWith('ugoira_'))
        ? 'gif' : 'image';
    }

    // 生成统一 id
    const id = record.cacheKey?.includes(':')
      ? record.cacheKey
      : PixivEntity.makeId(record.illustId, record.pageIndex ?? 0);

    return new PixivEntity({
      id,
      illustId: record.illustId,
      pageIndex: record.pageIndex ?? 0,
      type,
      state,
      flags: record.flags || {},
      fileName: record.fileName || '',
      title: record.title || '',
      author: record.author || '',
      authorName: record.authorName || record.author || '',
      authorAccount: record.authorAccount || '',
      authorId: record.authorId || '',
      tags: record.tags || [],
      cachedAt: record.cachedAt || Date.now(),
      size: record.size || 0,
      frames: record.frames,
      frameCount: record.frameCount,
      pixivUrl: record.pixivUrl || '',
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
      pageIndex: this.pageIndex,
      type: this.type,
      state: this.state,
      flags: this.flags,
      fileName: this.fileName,
      title: this.title,
      author: this.author,
      authorName: this.authorName,
      authorAccount: this.authorAccount,
      authorId: this.authorId,
      tags: this.tags,
      cachedAt: this.cachedAt,
      size: this.size,
      frames: this.frames,
      frameCount: this.frameCount,
      pixivUrl: this.pixivUrl,
      originalUrl: this.originalUrl,
      thumbnailUrl: this.thumbnailUrl,
      mediumUrl: this.mediumUrl,
      _contentUri: this._contentUri,
      likedAt: this.likedAt,
    };
  }
}
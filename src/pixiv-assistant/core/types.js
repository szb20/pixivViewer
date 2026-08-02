/**
 * Pixiv 数据模型 — JSDoc 类型定义。
 *
 * @module pixiv-assistant/types
 */

/**
 * Pixiv 插画搜索结果（单条）
 * @typedef {Object} PixivIllust
 * @property {string}  illustId
 * @property {string}  title
 * @property {string}  author
 * @property {string}  authorId
 * @property {string}  thumbnailUrl
 * @property {string}  mediumUrl
 * @property {string}  [originalUrl]  — 原图（最高画质）URL，详情接口返回
 * @property {string[]} tags
 * @property {string}  pixivUrl
 * @property {number}  width
 * @property {number}  height
 * @property {number}  illustType  — 0=静态插画, 2=GIF 动图
 * @property {number}  pageCount
 */

/**
 * Pixiv 插画详情（含多页图）
 * @typedef {Object} PixivIllustDetail
 * @property {string}  illustId
 * @property {string}  title
 * @property {string}  author
 * @property {string}  authorId
 * @property {number}  pageCount
 * @property {number}  illustType
 * @property {Array<{index:number, url:string, thumbnailUrl:string, originalUrl:string}>} images
 * @property {string[]} tags
 * @property {string}  pixivUrl
 * @property {number}  width
 * @property {number}  height
 */

/**
 * Pixiv 排行榜条目
 * @typedef {Object} PixivRankingItem
 * @property {string}  illustId
 * @property {string}  title
 * @property {string}  author
 * @property {string}  authorId
 * @property {string}  thumbnailUrl
 * @property {string}  mediumUrl
 * @property {string[]} tags
 * @property {string}  pixivUrl
 * @property {number}  pageCount
 * @property {number}  illustType
 * @property {number}  rank
 * @property {number}  viewCount
 * @property {number}  ratingCount
 */

/**
 * Ugoira 动图元数据
 * @typedef {Object} PixivGifMeta
 * @property {string}  illustId
 * @property {string}  title
 * @property {string}  author
 * @property {string}  authorId
 * @property {number}  frameCount
 * @property {Array<{file:string, path:string, delay:number}>} frames
 * @property {number}  totalDuration
 * @property {string}  pixivUrl
 */

/**
 * Pixiv 缓存元数据
 * @typedef {Object} PixivCacheMeta
 * @property {string}  cacheKey
 * @property {string}  illustId
 * @property {number}  [pageIndex]
 * @property {string}  [title]
 * @property {string}  [author]
 * @property {string}  [authorId]
 * @property {string}  [fileName]
 * @property {number}  [saved]     — 1=已永久保存, 0=自动缓存
 * @property {number}  [cachedAt]  — 缓存时间戳
 * @property {string}  [originalUrl]
 * @property {string}  [thumbnailUrl]
 * @property {string}  [mediumUrl]
 * @property {string}  [pixivUrl]
 * @property {string[]} [tags]
 * @property {number}  [size]
 */

export {};

/**
 * buildLikeMeta — 从作品条目构建"喜欢"所需的展示元数据（缩略图/标题/作者/tags 等）。
 * 详情页 LikeButton 与 grid 封面 ♥ 共用，避免重复。
 * @param {object} img 作品条目
 */
export function buildLikeMeta(img) {
  const m = img || {};
  return {
    thumbnailUrl: m.thumbnailUrl || m.mediumUrl || '',
    title: m.title || '',
    author: m.author || '',
    authorName: m.authorName || m.author || '',
    authorAccount: m.authorAccount || '',
    authorAvatar: m.authorAvatar || '',
    authorId: m.authorId || '',
    tags: m.tags || [],
    pixivUrl: m.pixivUrl || '',
    pageCount: m.pageCount || m._totalPages || 0,
    width: m.width || 0,
    height: m.height || 0,
    type: m.type === 'gif' || m.illustType === 2 ? 'gif' : 'image',
  };
}

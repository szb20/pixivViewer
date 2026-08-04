// ═══════════════════════════════════════════════════════
// Pixiv 数据处理
// ═══════════════════════════════════════════════════════

import { pixivReUrl } from '../../pixiv-assistant/core/utils.js';

/** 将 Pixiv API 返回的原始结果展开为全部页面（格子只渲染 page 0）*/
export function parsePixivResults(rawList) {
  return rawList.flatMap(r => {
    const pageCount = r.pageCount || r._totalPages || 1;
    const illustId = r.illustId;
    const entries = [];
    for (let p = 0; p < pageCount; p++) {
      entries.push({
        ...r,
        illustId,
        _pageIndex: p,
        _totalPages: pageCount,
        _msgId: 'pixiv-gallery',
        type: r.illustType === 2 ? 'gif' : 'image',
        mediumUrl: pixivReUrl(String(illustId), p),
        originalUrl: r.originalUrl || pixivReUrl(String(illustId), p),
        thumbnailUrl: p === 0 ? r.thumbnailUrl : pixivReUrl(String(illustId), p),
      });
    }
    return entries;
  });
}

/** 将 parsePixivResults 条目转为 allMedia 格式，供 ImageDetailView 使用 */
export function allMediaFromRelated(img) {
  const w = img.width || 0;
  const h = img.height || 0;
  return {
    type: img.type === 'gif' ? 'gif' : 'image',
    src: img._pageIndex > 0
      ? pixivReUrl(img.illustId, img._pageIndex)
      : (img.mediumUrl || img.thumbnailUrl),
    title: img.title,
    author: img.author,
    authorId: img.authorId || '',
    authorName: img.authorName || img.author || '',
    authorAccount: img.authorAccount || '',
    pixivUrl: img.pixivUrl,
    illustId: img.illustId,
    _pageIndex: img._pageIndex,
    _totalPages: img._totalPages,
    thumbnailUrl: img.thumbnailUrl,
    mediumUrl: img.mediumUrl,
    originalUrl: img.originalUrl || img.mediumUrl,
    width: w,
    height: h,
    tags: img.tags || [],
    _lazy: img.type === 'gif' ? true : undefined,
  };
}

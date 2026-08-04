/**
 * 作品状态工具 — 从 pixivCache 派生「已喜欢 / 已保存」的 illustId 集合。
 *
 * 键格式为 `${illustId}_${pageIndex}`，同一作品任意页命中即视为已收藏/已保存。
 */
export function buildLikedOrSavedSet(pixivCache) {
  const set = new Set();
  for (const [key, val] of Object.entries(pixivCache || {})) {
    if (!val?.liked && !val?.saved) continue;
    const idx = key.lastIndexOf('_');
    if (idx > 0) set.add(key.slice(0, idx));
  }
  return set;
}

/** 从 likedSet 派生「已喜欢」的 illustId 集合（任意页命中即算） */
export function buildLikedIllustIdSet(likedSet) {
  const set = new Set();
  likedSet?.forEach((key) => {
    const idx = key.lastIndexOf('_');
    if (idx > 0) set.add(key.slice(0, idx));
  });
  return set;
}

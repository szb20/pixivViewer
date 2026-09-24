/**
 * 作品状态工具 — 从 pixivCache 派生「已喜欢 / 已保存」的 illustId 集合。
 *
 * 键由 getCompositeKey 生成，格式统一为 `${illustId}_${pageIndex}`
 * （illustId 为纯数字，页码为非负整数，取最后一个 `_` 之后必为页码）。
 */

/** 从复合键反解 illustId（结构化约定：`{illustId}_{pageIndex}`，illustId 不含 `_`） */
function illustIdOfCompositeKey(key) {
  const k = String(key);
  const idx = k.lastIndexOf('_');
  // 无 `_`（裸 illustId）或 `_` 后不是纯数字页码 → 整个 key 就是 illustId
  if (idx <= 0 || !/^\d+$/.test(k.slice(idx + 1))) return k;
  return k.slice(0, idx);
}

export function buildLikedOrSavedSet(pixivCache) {
  const set = new Set();
  for (const [key, val] of Object.entries(pixivCache || {})) {
    if (!val?.liked && !val?.saved) continue;
    set.add(illustIdOfCompositeKey(key));
  }
  return set;
}

/** 从 likedSet 派生「已喜欢」的 illustId 集合（任意页命中即算） */
export function buildLikedIllustIdSet(likedSet) {
  const set = new Set();
  likedSet?.forEach((key) => set.add(illustIdOfCompositeKey(key)));
  return set;
}
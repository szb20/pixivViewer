import { MasonryFeed } from '../ImageGrid.jsx';
import { allMediaFromRelated } from './helpers.js';

/**
 * 详情页相关推荐瀑布流 — 布局复用首页 MasonryFeed（全站唯一瀑布流实现）。
 * 做同作品去重，并过滤当前作品、已喜欢/已保存作品。
 */
export default function RelatedGrid({
  related,
  currentIllustId,
  likedOrSavedSet,
  relatedRef,
  onSelectImage,
  onLongPress,
}) {
  if (!related?.length) return null;
  const seen = new Set();
  const visibleRelated = [];
  for (const img of related) {
    if (img._pageIndex !== 0) continue;
    if (img.illustId === currentIllustId) continue;
    if (likedOrSavedSet.has(img.illustId)) continue;
    if (seen.has(img.illustId)) continue;
    seen.add(img.illustId);
    visibleRelated.push(img);
  }
  if (!visibleRelated.length) return null;
  const navItems = visibleRelated.map(allMediaFromRelated);

  return (
    <MasonryFeed
      items={visibleRelated}
      onOpen={(it, index) => onSelectImage?.(allMediaFromRelated(it), { items: navItems, index })}
      onLongPress={onLongPress}
      containerRef={(node) => {
        if (typeof relatedRef === 'function') relatedRef(node);
        else if (relatedRef) relatedRef.current = node;
      }}
      containerProps={{ 'data-detail-anchor': 'related' }}
    />
  );
}
import GridItem from '../GridItem.jsx';
import { gridThumbUrl } from '../../utils/quality.js';
import { allMediaFromRelated } from './helpers.js';

/**
 * 详情页相关推荐网格。
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
  const navItems = visibleRelated.map(allMediaFromRelated);

  return (
    <div className="pixiv-grid" ref={relatedRef} data-detail-anchor="related">
      {visibleRelated.map((img, index) => {
        return (
          <GridItem
            key={`rel-${img.illustId}`}
            img={img}
            index={index}
            onOpen={(it) => onSelectImage?.(allMediaFromRelated(it), { items: navItems, index })}
            onLongPress={onLongPress}
            variant="media"
            thumbSrc={gridThumbUrl(img.thumbnailUrl || img.mediumUrl)}
          />
        );
      })}
    </div>
  );
}

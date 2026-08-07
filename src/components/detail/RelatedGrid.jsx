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

  return (
    <div className="pixiv-grid" ref={relatedRef} data-detail-anchor="related">
      {related.map((img, index) => {
        if (img._pageIndex !== 0) return null;
        if (img.illustId === currentIllustId) return null;
        if (likedOrSavedSet.has(img.illustId)) return null;
        if (seen.has(img.illustId)) return null;
        seen.add(img.illustId);
        return (
          <GridItem
            key={`rel-${img.illustId}`}
            img={img}
            index={index}
            onOpen={(it) => onSelectImage?.(allMediaFromRelated(it))}
            onLongPress={onLongPress}
            variant="media"
            thumbSrc={gridThumbUrl(img.thumbnailUrl || img.mediumUrl)}
          />
        );
      })}
    </div>
  );
}

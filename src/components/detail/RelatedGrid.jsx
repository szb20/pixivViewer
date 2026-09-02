import GridItem from '../GridItem.jsx';
import { masonryThumbUrl } from '../ImageGrid.jsx';
import { allMediaFromRelated } from './helpers.js';

// 列数：手机 2 列；桌面按窗口宽度推算
function relatedColCount() {
  if (typeof window === 'undefined') return 2;
  return window.innerWidth >= 900
    ? Math.min(6, Math.max(3, Math.floor(window.innerWidth / 180)))
    : 2;
}

/**
 * 详情页相关推荐瀑布流。
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

  // 按估算高度均衡分配到各列（等比例高度=1/宽高比）；同时给每项算真实宽高比用于加载前占位
  const colCount = relatedColCount();
  const cols = Array.from({ length: colCount }, () => []);
  const heights = new Array(colCount).fill(0);
  const ratios = visibleRelated.map((img) => {
    const w = Number(img?.width) || 0;
    const h = Number(img?.height) || 0;
    return w > 0 && h > 0 ? w / h : 1;
  });
  visibleRelated.forEach((img, i) => {
    const ratio = ratios[i];
    const col = heights.indexOf(Math.min(...heights));
    cols[col].push(i);
    heights[col] += 1 / Math.max(ratio, 0.3);
  });

  return (
    <div className="grid--masonry" ref={relatedRef} data-detail-anchor="related">
      <div className="masonry-cols">
        {cols.map((col, ci) => (
          <div className="masonry-col" key={ci}>
            {col.map((idx) => {
              const img = visibleRelated[idx];
              return (
                <GridItem
                  key={`rel-${img.illustId}`}
                  img={img}
                  index={idx}
                  ratio={ratios[idx]}
                  onOpen={(it) => onSelectImage?.(allMediaFromRelated(it), { items: navItems, index: idx })}
                  onLongPress={onLongPress}
                  variant="masonry"
                  thumbSrc={masonryThumbUrl(img.thumbnailUrl || img.mediumUrl || '')}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
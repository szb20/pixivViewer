import { useEffect, useRef, useState } from 'react';
import GridItem from '../GridItem.jsx';
import { masonryThumbUrl } from '../ImageGrid.jsx';
import { allMediaFromRelated } from './helpers.js';

const MIN_COL_WIDTH = 250;

// 列数：根据容器实际宽度推算，每列至少 MIN_COL_WIDTH 宽
function relatedColCount(containerWidth) {
  if (!containerWidth || containerWidth <= 0) return 2;
  return Math.max(1, Math.round(containerWidth / MIN_COL_WIDTH));
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
  const containerRef = useRef(null);
  const [colCount, setColCount] = useState(2);

  // 用 ResizeObserver 监听容器实际宽度，动态计算列数
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      setColCount(relatedColCount(w));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    <div className="grid--masonry" ref={(node) => {
      containerRef.current = node;
      if (typeof relatedRef === 'function') relatedRef(node);
      else if (relatedRef) relatedRef.current = node;
    }} data-detail-anchor="related">
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
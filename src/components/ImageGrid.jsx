import { memo, useMemo } from 'react';
import GridItem from './GridItem.jsx';
import { buildLikedIllustIdSet } from '../utils/worksState.js';
import { hiddenWorks, useHiddenWorks } from '../utils/hiddenWorks.js';
import { useGridLikeToggle } from '../hooks/useGridLikeToggle.js';
import { showToast } from '../utils/toast.js';

/* ===== 推荐页瀑布流：按真实宽高比排双列，无尺寸时用稳定的伪随机比例兜底 ===== */
const MASONRY_RATIOS = [1, 4 / 5, 3 / 4, 1, 4 / 5, 3 / 4, 2 / 3, 1];
const RATIO_MIN = 0.58;
const RATIO_MAX = 1.9;
const FEATURED_MIN = 0.8;
const FEATURED_MAX = 1.5;

function clampRatio(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function fallbackRatio(illustId) {
  const id = String(illustId || '');
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0;
  return MASONRY_RATIOS[n % MASONRY_RATIOS.length];
}

function getCardRatio(img, featured = false) {
  const w = Number(img?.width) || 0;
  const h = Number(img?.height) || 0;
  const r = w > 0 && h > 0 ? w / h : fallbackRatio(img?.illustId);
  return featured ? clampRatio(r, FEATURED_MIN, FEATURED_MAX) : clampRatio(r, RATIO_MIN, RATIO_MAX);
}

function MasonryFeed({ items, likedIllustIds, onOpen, toggleLike, onHide }) {
  const ratios = useMemo(() => items.map(img => getCardRatio(img)), [items]);
  const plan = useMemo(() => {
    if (!items.length) return null;
    const cols = [[], []];
    const heights = [0, 0];
    // 第 0 张作为全宽精选位，其余按估算高度均衡分配到两列
    for (let i = 1; i < items.length; i++) {
      const col = heights[0] <= heights[1] ? 0 : 1;
      cols[col].push(i);
      heights[col] += 1 / Math.max(ratios[i], 0.3);
    }
    return { cols };
  }, [items, ratios]);

  if (!plan) return null;

  const renderItem = (i) => (
    <GridItem
      key={items[i].illustId}
      img={items[i]}
      index={i}
      ratio={ratios[i]}
      isLiked={likedIllustIds.has(items[i].illustId)}
      onOpen={onOpen}
      onLongPress={toggleLike}
      onHide={onHide}
      variant="masonry"
    />
  );

  return (
    <div className="grid--masonry">
      <div className="masonry-featured">{renderItem(0)}</div>
      <div className="masonry-cols">
        <div className="masonry-col">{plan.cols[0].map(renderItem)}</div>
        <div className="masonry-col">{plan.cols[1].map(renderItem)}</div>
      </div>
    </div>
  );
}

const ImageGrid = memo(function ImageGrid({ items, likedSet, onOpen, layout = 'grid' }) {
  const hiddenSet = useHiddenWorks();
  const toggleLike = useGridLikeToggle();
  // 同作品任意页点过喜欢都显示红心（不只看第 0 页）
  const likedIllustIds = useMemo(() => buildLikedIllustIdSet(likedSet), [likedSet]);

  // 过滤"不想看"的作品（✕ 加入后从所有网格实时消失）
  const visibleItems = useMemo(
    () => (hiddenSet.size ? items.filter(img => !hiddenSet.has(img.illustId)) : items),
    [items, hiddenSet],
  );

  if (!visibleItems?.length) return null;

  const handleHide = (id) => {
    hiddenWorks.add(id);
    showToast('已隐藏，不再推荐', { type: 'info' });
  };

  if (layout === 'masonry') {
    return (
      <MasonryFeed
        items={visibleItems}
        likedIllustIds={likedIllustIds}
        onOpen={onOpen}
        toggleLike={toggleLike}
        onHide={handleHide}
      />
    );
  }

  return (
    <div className="grid">
      {visibleItems.map((img, index) => (
        <GridItem
          key={img.illustId}
          img={img}
          index={index}
          isLiked={likedIllustIds.has(img.illustId)}
          onOpen={(openImg) => onOpen?.(openImg, { items: visibleItems, index })}
          onLongPress={toggleLike}
          onHide={handleHide}
          variant="grid"
        />
      ))}
    </div>
  );
});

export default ImageGrid;

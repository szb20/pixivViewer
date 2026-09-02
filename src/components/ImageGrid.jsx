import { memo, useMemo } from 'react';
import GridItem from './GridItem.jsx';
import { pixivPageUrl } from '../pixiv-assistant/core/utils.js';
import { buildLikedIllustIdSet } from '../utils/worksState.js';
import { hiddenWorks, useHiddenWorks } from '../utils/hiddenWorks.js';
import { useGridLikeToggle } from '../hooks/useGridLikeToggle.js';
import { useGridLayout } from '../hooks/useGridLayout.js';
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

// 方形缩略图（c/250x250_80_a2/.../square1200.jpg）→ small 档（c/540x540_70/.../master1200.jpg）。
// 与详情页 small 预览图同档同路径：540px 长边等比、不裁剪，内容和比例一致。
export function masonryThumbUrl(url) {
  if (!url || typeof url !== 'string') return '';
  // 先转成 img-master 等比底座（已处理 dev 代理），再补上 small 档的 c/540x540_70 前缀
  const base = pixivPageUrl(url, 0, 1200);
  if (!base) return url;
  return base
    .replace('https://i.pixiv.re/img-master', 'https://i.pixiv.re/c/540x540_70/img-master')
    .replace('/pixiv-img/img-master', '/pixiv-img/c/540x540_70/img-master');
}

function MasonryFeed({ items, likedIllustIds, onOpen, toggleLike, onHide }) {
  const ratios = useMemo(() => items.map(img => getCardRatio(img)), [items]);
  const plan = useMemo(() => {
    if (!items.length) return null;
    // 列数自适应：手机 <900px 固定 2 列；桌面按窗口宽度/最小卡片宽(140px)推算，
    // 上不封顶到 14 列（密铺瀑布流，Pinterest 风格）
    const colCount = typeof window !== 'undefined'
      ? (window.innerWidth >= 900
        ? Math.min(14, Math.max(4, Math.floor(window.innerWidth / 140)))
        : 2)
      : 2;
    const cols = Array.from({ length: colCount }, () => []);
    const heights = new Array(colCount).fill(0);
    // 全部条目（含首条）按估算高度均衡分配到各列 → 真正的瀑布流，无全宽精选位
    for (let i = 0; i < items.length; i++) {
      const col = heights.indexOf(Math.min(...heights));
      cols[col].push(i);
      heights[col] += 1 / Math.max(ratios[i], 0.3);
    }
    return { cols, colCount };
  }, [items, ratios]);

  if (!plan) return null;

  const renderItem = (i) => {
    const img = items[i];
    // 瀑布流用等比缩略图（540px），不用方形 250px 裁剪图，避免"方像素拼成瀑布"。
    const thumbSrc = masonryThumbUrl(img.thumbnailUrl || img.mediumUrl || '')
      || img.thumbnailUrl
      || img.mediumUrl;
    return (
      <GridItem
        key={img.illustId}
        img={img}
        index={i}
        ratio={ratios[i]}
        isLiked={likedIllustIds.has(img.illustId)}
        onOpen={onOpen}
        onLongPress={toggleLike}
        onHide={onHide}
        variant="masonry"
        thumbSrc={thumbSrc}
      />
    );
  };

  return (
    <div className="grid--masonry" style={{ '--masonry-cols': plan.colCount }}>
      <div className="masonry-cols">
        {plan.cols.map((col, ci) => (
          <div className="masonry-col" key={ci}>{col.map(renderItem)}</div>
        ))}
      </div>
    </div>
  );
}

const ImageGrid = memo(function ImageGrid({ items, likedSet, onOpen, layout = 'auto' }) {
  // layout='auto'（默认，绝大多数调用方）：跟随设置页「网格样式」开关（瀑布流/方形宫格）
  const gridLayout = useGridLayout();
  const resolvedLayout = layout === 'auto' ? gridLayout : layout;
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

  if (resolvedLayout === 'masonry') {
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
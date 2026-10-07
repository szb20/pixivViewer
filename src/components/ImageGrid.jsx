import { memo, useCallback, useMemo, useEffect, useRef, useState } from 'react';
import GridItem from './GridItem.jsx';
import { masonryThumbUrl } from '../utils/imageUrl.js';
import { buildLikedIllustIdSet } from '../utils/worksState.js';
import { hiddenWorks, useHiddenWorks } from '../utils/hiddenWorks.js';
import { useGridLikeToggle } from '../hooks/useGridLikeToggle.js';
import { useGridLayout } from '../hooks/useGridLayout.js';
import { getSource } from '../sources/registry.js';
import { showToast } from '../utils/toast.js';

/* ===== 推荐页瀑布流：按真实宽高比排双列，无尺寸时用稳定的伪随机比例兜底 ===== */
const MASONRY_RATIOS = [1, 4 / 5, 3 / 4, 1, 4 / 5, 3 / 4, 2 / 3, 1];
// 横图统一钳 1:1（放开横图后横向卡片过小，用户回退）；竖图范围由来源注册表的 ratioRange 决定：
// pixiv 保持竖/方，图库/壁纸站允许更窄的竖幅。

function clampRatio(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function fallbackRatio(illustId) {
  const id = String(illustId || '');
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0;
  return MASONRY_RATIOS[n % MASONRY_RATIOS.length];
}

function getCardRatio(img) {
  const w = Number(img?.width) || 0;
  const h = Number(img?.height) || 0;
  const r = w > 0 && h > 0 ? w / h : fallbackRatio(img?.illustId);
  // pixiv 条目没有 source 字段，getSource 兜底到 pixiv 的竖图范围
  const { min, max } = getSource(img?.source).ratioRange || { min: 0.5, max: 1 };
  return clampRatio(r, min, max);
}

const MIN_COL_WIDTH = 250;

/**
 * 瀑布流网格 — 唯一实现，首页 feed 与详情页相关推荐共用。
 * 按估算高度（1/宽高比）均衡分配到各列，列数由容器宽度实时推算。
 *
 * @param {array}    items          作品条目
 * @param {Set}      likedIllustIds 可选，命中则显示红心
 * @param {function} onOpen         (img, index) => void
 * @param {function} toggleLike     可选，长按触发
 * @param {function} onHide         可选，提供则显示 ✕
 * @param {ref|function} containerRef  可选，转发容器 ref
 * @param {object}   containerProps 可选，附加到容器（如 data-detail-anchor）
 */
export function MasonryFeed({ items, likedIllustIds, onOpen, toggleLike, onHide, containerRef, containerProps }) {
  const innerRef = useRef(null);
  const [colCount, setColCount] = useState(2);

  // 用 ResizeObserver 监听容器实际宽度，动态计算列数
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      // 容器 display:none 时宽度为 0：跳过，避免列数被重置为 2，
      // 恢复可见后列数变化会导致条目跨列搬家（React 重挂 → 图片重新淡入）
      if (!w) return;
      setColCount(Math.max(2, Math.round(w / MIN_COL_WIDTH)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ratios = useMemo(() => items.map(img => getCardRatio(img)), [items]);
  const plan = useMemo(() => {
    if (!items.length) return null;
    const cols = Array.from({ length: colCount }, () => []);
    const heights = new Array(colCount).fill(0);
    // 全部条目（含首条）按估算高度均衡分配到各列 → 真正的瀑布流，无全宽精选位
    for (let i = 0; i < items.length; i++) {
      const col = heights.indexOf(Math.min(...heights));
      cols[col].push(i);
      heights[col] += 1 / Math.max(ratios[i], 0.3);
    }
    return { cols, colCount };
  }, [items, ratios, colCount]);

  if (!plan) return null;

  const renderItem = (i) => {
    const img = items[i];
    // 瀑布流用等比缩略图（540px），不用方形 250px 裁剪图，避免"方像素拼成瀑布"。
    const thumbSrc = masonryThumbUrl(img.thumbnailUrl || img.mediumUrl || '', 0, img.source)
      || img.thumbnailUrl
      || img.mediumUrl;
    return (
      <GridItem
        key={img.illustId}
        img={img}
        index={i}
        ratio={ratios[i]}
        isLiked={likedIllustIds?.has(String(img.illustId)) ?? false}
        onOpen={onOpen}
        onLongPress={toggleLike}
        onHide={onHide}
        variant="masonry"
        thumbSrc={thumbSrc}
      />
    );
  };

  return (
    <div
      className="grid--masonry"
      ref={(node) => {
        innerRef.current = node;
        if (typeof containerRef === 'function') containerRef(node);
        else if (containerRef) containerRef.current = node;
      }}
      {...containerProps}
      style={{ '--masonry-cols': plan.colCount }}
    >
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

  const handleHide = useCallback((id) => {
    hiddenWorks.add(id);
    showToast('已隐藏，不再推荐', { type: 'info' });
  }, []);

  // 宫格/瀑布流共用：包装成 { items, index } 供详情页左右切换（GridItem 传出的 index 是 items 下标）
  const handleGridOpen = useCallback((img, index) => {
    onOpen?.(img, { items: visibleItems, index });
  }, [onOpen, visibleItems]);

  if (!visibleItems?.length) return null;

  if (resolvedLayout === 'masonry') {
    return (
      <MasonryFeed
        items={visibleItems}
        likedIllustIds={likedIllustIds}
        onOpen={handleGridOpen}
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
          onOpen={handleGridOpen}
          onLongPress={toggleLike}
          onHide={handleHide}
          variant="grid"
        />
      ))}
    </div>
  );
});

export default ImageGrid;
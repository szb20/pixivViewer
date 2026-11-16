import { useEffect, useMemo, useRef, useState } from 'react';
import GridItem from './GridItem.jsx';
import { masonryThumbUrl } from '../utils/imageUrl.js';
import { getMediaDims, useMediaDimsVersion } from '../utils/mediaDims.js';
import { useProgressiveMount } from '../hooks/useProgressiveMount.js';
import { getSource } from '../sources/registry.js';

/* ===== 卡片比例：API 自带宽高 → 学到的尺寸（mediaDims）→ 1:1 =====
 * X 源接口没有宽高，靠缩略图加载后学到的尺寸兜；再拿不到就 1:1。
 * 不再用伪随机比例：猜错的形状只会让卡片与图片对不上。
 * 横图统一钳 1:1（放开横图后横向卡片过小，用户回退）；竖图范围由来源注册表的
 * ratioRange 决定：pixiv 保持竖/方，图库/壁纸站允许更窄的竖幅。 */
function clampRatio(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function getCardRatio(img) {
  const w = Number(img?.width) || 0;
  const h = Number(img?.height) || 0;
  let r = w > 0 && h > 0 ? w / h : 0;
  if (!r) {
    const d = getMediaDims(img?.illustId, 0);
    if (d) r = d.w / d.h;
  }
  // pixiv 条目没有 source 字段，getSource 兜底到 pixiv 的竖图范围
  const { min, max } = getSource(img?.source).ratioRange || { min: 0.5, max: 1 };
  return clampRatio(r || 1, min, max);
}

const MIN_COL_WIDTH = 250;

/**
 * 瀑布流网格 — 唯一实现，首页 feed 与详情页相关推荐共用。
 * 按估算高度（1/宽高比）均衡分配到各列，列数由容器宽度实时推算。
 *
 * @param {array}    items          作品条目
 * @param {Set}      likedIllustIds 可选，命中则显示红心
 * @param {function} onOpen         (img, index) => void
 * @param {function} onLongPress    可选，长按触发（下载全部页）
 * @param {function} onLike         可选，左下角红心点按触发（切喜欢）
 * @param {function} onHide         可选，提供则显示 ✕
 * @param {ref|function} containerRef  可选，转发容器 ref
 * @param {object}   containerProps 可选，附加到容器（如 data-detail-anchor）
 */
export function MasonryFeed({ items, likedIllustIds, onOpen, onLongPress, onLike, onHide, containerRef, containerProps }) {
  const innerRef = useRef(null);
  const [colCount, setColCount] = useState(2);
  // 缩略图加载中学到尺寸（X 源没有 API 宽高）→ 版本号变化 → ratios 重算，卡片重排成真实形状
  const dimsVersion = useMediaDimsVersion();

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

  // dimsVersion 是外部尺寸缓存（mediaDims）的版本号：值本身不参与计算，
  // 只负责在缩略图学到新尺寸时让 ratios 重算，属于刻意的响应式依赖
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const ratios = useMemo(() => items.map(img => getCardRatio(img)), [items, dimsVersion]);
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

  // 渐进挂载（见 useProgressiveMount 注释）。注意必须在所有条件 return 之前调用
  const { renderCap, sentinelRef } = useProgressiveMount(items.length);

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
        onLongPress={onLongPress}
        onLike={onLike}
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
          <div className="masonry-col" key={ci}>{col.filter(i => i < renderCap).map(renderItem)}</div>
        ))}
      </div>
      {items.length > renderCap && <div ref={sentinelRef} style={{ height: 1 }} />}
    </div>
  );
}

export default MasonryFeed;

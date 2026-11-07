/**
 * 骨架屏 — 首拉 / 触底翻页时的占位卡片，替代原先的「加载中...」文字。
 * 复用 .grid / .grid-item 的既有规格（列数、圆角、卡片比例随断点自动一致），
 * 扫光动画与缩略图加载占位（grid-shimmer）同一套质感。
 *
 * @param {number} props.count 占位卡片数：首拉约两屏（12），触底一行（6）
 */
export default function SkeletonGrid({ count = 6 }) {
  return (
    <div className="grid skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="grid-item grid-shimmer skeleton-item" style={{ '--sk-i': i }} />
      ))}
    </div>
  );
}

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import HeartIcon from './icons/HeartIcon.jsx';

const LONG_PRESS_MS = 500;

/**
 * 网格项 — 统一复用：缩略图 + 页数角标 + GIF 指示 + 红心 + 点击 + 长按 + 失败占位。
 *
 * variant 只区分布局与失败处理，视觉类名全局统一为 .grid-item 一套：
 * - grid     → 宫格（主 feed / 排行 / 收藏 / 作者页 / 相关推荐）
 * - masonry  → 瀑布流（类名同宫格，样式由 .grid--masonry 容器作用域接管）
 * - gallery  → 喜欢页（同 .grid-item，额外支持加载失败占位重试）
 *
 * @param {object}  img         作品条目（illustId / thumbnailUrl / mediumUrl / pageCount / type ...）
 * @param {boolean} isLiked     是否显示红心
 * @param {function} onOpen     (img) => void，点击打开
 * @param {function} onLongPress (img) => void，提供则启用长按（长按后不再触发 onOpen）
 * @param {function} onHide      (id) => void，提供则在右上角显示 ✕（不想看/不再推荐）
 * @param {string}   variant    'grid' | 'media' | 'gallery'
 * @param {string}   thumbSrc   覆盖缩略图 src（如 gridThumbUrl 处理后的 URL）
 */
export default memo(function GridItem({
  img,
  isLiked = false,
  onOpen,
  onLongPress,
  onHide,
  variant = 'grid',
  thumbSrc,
  index = 0,
  ratio,
}) {
  const v = {
    item: 'grid-item',
    thumb: 'grid-thumb',
    badge: 'grid-pages',
    play: 'grid-play',
    like: 'grid-like',
  };

  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [pressState, setPressState] = useState('idle');
  const longPressTimerRef = useRef(null);
  const pressFeedbackTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const pressStartRef = useRef(null);
  const src = thumbSrc || img.thumbnailUrl || img.mediumUrl || '';
  const pageCount = Number(img._totalPages || img.pageCount) || 1;
  const isGif = img.type === 'gif' || Number(img.illustType) === 2;

  useEffect(() => () => {
    clearTimeout(longPressTimerRef.current);
    clearTimeout(pressFeedbackTimerRef.current);
  }, []);

  const triggerLongPress = useCallback(() => {
    if (longPressTriggeredRef.current) return;
    longPressTriggeredRef.current = true;
    clearTimeout(longPressTimerRef.current);
    clearTimeout(pressFeedbackTimerRef.current);
    pressStartRef.current = null;
    setPressState('confirmed');
    pressFeedbackTimerRef.current = setTimeout(() => setPressState('idle'), 420);
    onLongPress?.(img);
  }, [img, onLongPress]);

  const startLongPress = useCallback((e) => {
    if (!onLongPress) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    longPressTriggeredRef.current = false;
    setPressState('pressing');
    clearTimeout(longPressTimerRef.current);
    clearTimeout(pressFeedbackTimerRef.current);
    longPressTimerRef.current = setTimeout(triggerLongPress, LONG_PRESS_MS);
  }, [onLongPress, triggerLongPress]);

  const moveLongPress = useCallback((e) => {
    const start = pressStartRef.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10) {
      clearTimeout(longPressTimerRef.current);
      pressStartRef.current = null;
      setPressState('idle');
    }
  }, []);

  const cancelLongPress = useCallback(() => {
    clearTimeout(longPressTimerRef.current);
    pressStartRef.current = null;
    if (!longPressTriggeredRef.current) setPressState('idle');
  }, []);

  const handleClick = useCallback(() => {
    // 长按已触发下载 → 本次合成的 click 不再打开
    if (longPressTriggeredRef.current) { longPressTriggeredRef.current = false; return; }
    onOpen?.(img, index);
  }, [img, index, onOpen]);

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    triggerLongPress();
  }, [triggerLongPress]);

  const retryThumb = useCallback((e) => {
    e?.stopPropagation?.();
    setError(false);
  }, []);

  // 缩略图加载完成前显示高光扫描占位
  const shimmerCls = !loaded && !error ? ' grid-shimmer' : '';
  const stateCls = `${loaded ? ' is-loaded' : ''}${isLiked ? ' is-liked' : ''}${pressState === 'pressing' ? ' is-pressing' : ''}${pressState === 'confirmed' ? ' is-long-pressed' : ''}`;

  // gallery 变体：无缩略图 → 空占位；加载失败 → 占位重试
  if (variant === 'gallery') {
    if (!src) {
      return <div className={`${v.item} grid-shimmer`}><div className={v.thumb} /></div>;
    }
    if (error) {
      return (
        <div className={v.item} onClick={retryThumb}>
          <div className="grid-thumb-fallback">加载失败<br />点此重试</div>
        </div>
      );
    }
  }
  // 其它变体加载失败 → 隐藏
  if (error && variant !== 'gallery') return null;

  const thumb = (
    <>
      <img
        className={v.thumb}
        src={src}
        alt={img.title || ''}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
      {loaded && pageCount > 1 && (
        <span className={`${v.badge} frosted`}>{pageCount}</span>
      )}
      {loaded && isGif && <span className={v.play}>▶</span>}
    </>
  );

  return (
    <div
      className={`${v.item}${shimmerCls}${stateCls}`}
      style={
        variant === 'masonry'
          ? { aspectRatio: ratio || 1, '--item-index': index % 24 }
          : ratio
            ? { aspectRatio: ratio, '--item-index': index % 24 }
            : { '--item-index': index % 24 }
      }
      onClick={handleClick}
      onPointerDown={startLongPress}
      onPointerMove={moveLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onContextMenu={handleContextMenu}
    >
      {thumb}
      {loaded && isLiked && (
        <span className={v.like}><HeartIcon filled /></span>
      )}
      {loaded && onHide && (
        <button
          className="grid-hide"
          onClick={(e) => { e.stopPropagation(); onHide?.(img.illustId); }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="不再推荐"
        >✕</button>
      )}
    </div>
  );
});
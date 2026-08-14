import { memo, useCallback, useRef, useState } from 'react';
import HeartIcon from './icons/HeartIcon.jsx';

const LONG_PRESS_MS = 500;

/**
 * 网格项 — 统一复用：缩略图 + 页数角标 + GIF 指示 + 红心 + 点击 + 长按 + 失败占位。
 *
 * variant 决定使用的类名（视觉样式各自独立，逻辑共享）：
 * - grid     → 主 feed（.grid-item/.grid-thumb/.grid-pages/.grid-play/.grid-like）
 * - media    → 相关推荐 / 作者页（.pixiv-grid-item/.media-card-thumb/.pixiv-grid-pages/.gif-play-overlay）
 * - gallery  → 喜欢页（.gallery-item/.gallery-thumb/.gallery-thumb-fallback）
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
    grid:    { item: 'grid-item', thumb: 'grid-thumb', badge: 'grid-pages', play: 'grid-play', like: 'grid-like', wrap: '', gifOverlay: false },
    media:   { item: 'pixiv-grid-item', thumb: 'media-card-thumb', badge: 'pixiv-grid-pages', play: '', like: '', wrap: 'media-card-thumb-wrap', gifOverlay: true },
    gallery: { item: 'gallery-item', thumb: 'gallery-thumb', badge: 'grid-pages', play: 'grid-play', like: 'grid-like', wrap: '', gifOverlay: false },
    masonry: { item: 'grid-item grid-item--masonry', thumb: 'grid-thumb', badge: 'grid-pages', play: 'grid-play', like: 'grid-like', wrap: '', gifOverlay: false, cap: 'grid-cap' },
  }[variant] || { item: 'grid-item', thumb: 'grid-thumb', badge: 'grid-pages', play: 'grid-play', like: 'grid-like', wrap: '', gifOverlay: false };

  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const itemRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const pressStartRef = useRef(null);
  const src = thumbSrc || img.thumbnailUrl || img.mediumUrl || '';
  const pageCount = Number(img._totalPages || img.pageCount) || 1;
  const isGif = img.type === 'gif' || Number(img.illustType) === 2;

  const triggerLongPress = useCallback(() => {
    if (longPressTriggeredRef.current) return;
    longPressTriggeredRef.current = true;
    clearTimeout(longPressTimerRef.current);
    pressStartRef.current = null;
    onLongPress?.(img);
  }, [img, onLongPress]);

  const startLongPress = useCallback((e) => {
    if (!onLongPress) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    longPressTriggeredRef.current = false;
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(triggerLongPress, LONG_PRESS_MS);
  }, [onLongPress, triggerLongPress]);

  const moveLongPress = useCallback((e) => {
    const start = pressStartRef.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10) {
      clearTimeout(longPressTimerRef.current);
      pressStartRef.current = null;
    }
  }, []);

  const cancelLongPress = useCallback(() => {
    clearTimeout(longPressTimerRef.current);
    pressStartRef.current = null;
  }, []);

  const handleClick = useCallback(() => {
    // 长按已触发下载 → 本次合成的 click 不再打开
    if (longPressTriggeredRef.current) { longPressTriggeredRef.current = false; return; }
    const rect = itemRef.current?.getBoundingClientRect?.();
    const srcForTransition = src || img.thumbnailUrl || img.mediumUrl || img.originalUrl || '';
    const openImg = rect && srcForTransition
      ? {
          ...img,
          _openTransition: {
            src: srcForTransition,
            rect: {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            },
          },
        }
      : img;
    onOpen?.(openImg);
  }, [img, onOpen, src]);

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
  const stateCls = `${loaded ? ' is-loaded' : ''}${isLiked ? ' is-liked' : ''}`;

  // gallery 变体：无缩略图 → 空占位；加载失败 → 占位重试
  if (variant === 'gallery') {
    if (!src) {
      return <div className={`${v.item} grid-shimmer`}><div className={v.thumb} /></div>;
    }
    if (error) {
      return (
        <div className={v.item} onClick={retryThumb}>
          <div className="gallery-thumb-fallback">加载失败<br />点此重试</div>
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
        style={variant === 'grid' ? { opacity: loaded ? 1 : 0 } : undefined}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
      {loaded && v.badge && pageCount > 1 && (
        <span className={`${v.badge} frosted`}>{pageCount}</span>
      )}
      {loaded && isGif && (v.gifOverlay ? (
        <div className="gif-play-overlay"><span className="gif-play-icon">▶</span></div>
      ) : v.play ? (
        <span className={v.play}>▶</span>
      ) : null)}
    </>
  );

  return (
    <div
      ref={itemRef}
      className={`${v.item}${shimmerCls}${stateCls}`}
      style={ratio ? { aspectRatio: ratio, '--item-index': index % 24 } : { '--item-index': index % 24 }}
      onClick={handleClick}
      onPointerDown={startLongPress}
      onPointerMove={moveLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onContextMenu={handleContextMenu}
    >
      {v.wrap ? <div className={v.wrap}>{thumb}</div> : thumb}
      {loaded && v.cap && (
        <div className={v.cap}>
          <p className="grid-cap-title">{img.title || ''}</p>
          <p className="grid-cap-author">{img.authorName || img.author || ''}</p>
        </div>
      )}
      {loaded && isLiked && v.like && (
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

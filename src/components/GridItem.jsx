import { memo, useCallback, useEffect, useRef, useState } from 'react';
import HeartIcon from './icons/HeartIcon.jsx';
import { isSquareCropThumb, rememberMediaDims } from '../utils/mediaDims.js';

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
 * @param {function} onLike     (img) => void，提供则左下角红心变为可点按钮（点按切喜欢，不打开详情）
 * @param {function} onHide      (id) => void，提供则在右上角显示 ✕（不想看/不再推荐）
 * @param {string}   variant    'grid' | 'masonry' | 'gallery'
 * @param {string}   thumbSrc   覆盖缩略图 src（如瀑布流的等比 540 缩略图）
 */
export default memo(function GridItem({
  img,
  isLiked = false,
  onOpen,
  onLongPress,
  onLike,
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
  const imgRef = useRef(null);
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
    if (e.pointerType === 'touch') e.preventDefault();
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
    if (Math.abs(e.clientX - start.x) > 16 || Math.abs(e.clientY - start.y) > 16) {
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

  // 缩略图加载后把测到的真实尺寸入库（X 源接口没有宽高，网格/详情靠它兜真实比例）。
  // 方形裁剪缩略图除外（见 isSquareCropThumb）：那是裁过的，不是原图比例，记了反而污染。
  const reportDims = useCallback((im) => {
    const nw = im?.naturalWidth || 0;
    const nh = im?.naturalHeight || 0;
    if (!nw || !nh) return;
    if (isSquareCropThumb(nw, nh)) return;
    rememberMediaDims(img?.illustId, 0, nw, nh);
  }, [img?.illustId]);

  // src 变化（换图 / 重试后拿到新地址）时复位，避免一次失败就永久停在错误态
  useEffect(() => {
    setError(false);
    setLoaded(false);
  }, [src]);

  // 补挂载竞态：命中缓存的图可能在 React 收到 load 之前就已经 complete。
  // 实测（瀑布流放大/缩小触发跨列重挂，60 项）：丢了 load 的条目能到 29 个，全部卡在
  // opacity:0 —— 图早下完却看着永远加载不出来；而同样「先 src 后 onload」的原生
  // new Image() 写法 150/150 都收得到，说明这是 React 托管 img 的挂载期问题。
  // 这里在挂载/换 src 后查一次 DOM；真·未完成的图不在 complete 态，仍走 onLoad。
  useEffect(() => {
    const im = imgRef.current;
    if (!im || !src) return;
    if (!im.complete) return;
    // complete 但拿不到尺寸 = 这张图已经失败了（缓存里的失败也走这里）
    if (im.naturalWidth > 0) {
      setLoaded(true);
      reportDims(im);
    } else {
      setError(true);
    }
  }, [src, reportDims]);

  // 缩略图加载完成前显示高光扫描占位
  const shimmerCls = !loaded && !error ? ' grid-shimmer' : '';
  const stateCls = `${loaded ? ' is-loaded' : ''}${isLiked ? ' is-liked' : ''}${pressState === 'pressing' ? ' is-pressing' : ''}${pressState === 'confirmed' ? ' is-long-pressed' : ''}`;
  const itemStyle = variant === 'masonry'
    ? { aspectRatio: ratio || 1, '--item-index': index % 24 }
    : { '--item-index': index % 24 };

  // gallery 变体：无缩略图 → 空占位
  if (variant === 'gallery' && !src) {
    return <div className={`${v.item} grid-shimmer`}><div className={v.thumb} /></div>;
  }
  // 加载失败 → 显示占位（可点击重试），不再直接消失
  // （弱网下几张缩略图瞬时失败会让卡片凭空消失，且 key 复用后也不会回来）
  if (error) {
    return (
      <div className={`${v.item}${stateCls}`} style={itemStyle} onClick={retryThumb}>
        <div className="grid-thumb-fallback">加载失败<br />点此重试</div>
      </div>
    );
  }

  const thumb = (
    <>
      <img
        className={v.thumb}
        ref={imgRef}
        src={src}
        alt={img.title || ''}
        loading="lazy"
        decoding="async"
        onLoad={(e) => { setLoaded(true); reportDims(e.currentTarget); }}
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
      style={itemStyle}
      onClick={handleClick}
      onPointerDown={startLongPress}
      onPointerMove={moveLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onContextMenu={handleContextMenu}
    >
      {thumb}
      {loaded && onLike && (
        <button
          className={`${v.like} frosted${isLiked ? ' is-liked' : ''}`}
          onClick={(e) => { e.stopPropagation(); onLike(img); }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={isLiked ? '取消喜欢' : '喜欢'}
        ><HeartIcon filled={isLiked} /></button>
      )}
      {loaded && !onLike && isLiked && (
        <span className={`${v.like} frosted is-liked`}><HeartIcon filled /></span>
      )}
      {loaded && onHide && (
        <button
          className="grid-hide frosted"
          onClick={(e) => { e.stopPropagation(); onHide?.(img.illustId); }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="不再推荐"
        >✕</button>
      )}
    </div>
  );
});
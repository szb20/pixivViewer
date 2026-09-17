import { useCallback, useRef, useState } from 'react';
import { pixivReUrl } from '../../pixiv-assistant/core/utils.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('DetailPageBlock');

/**
 * 多图详情页的单页块 — 所有页面上下堆叠展示。
 * 进入视口时懒加载原图（本地相册优先 → 网络原图），
 * 原图就绪前用缩略图模糊铺底；点击打开灯箱；长按下载该页原图。
 */
export default function DetailPageBlock({
  page,
  totalPages,
  image,
  previewUrl,
  placeholderUrl,
  defaultRatio,
  cachedRatio,
  registerRef,
  onOpenLightbox,
  onLongPress,
  onRatioReady,
}) {
  const [failedSrc, setFailedSrc] = useState('');
  const [ratio, setRatio] = useState(null); // 预览图加载后按真实比例覆盖占位
  const [loadedSrc, setLoadedSrc] = useState(''); // 详情预览图是否已加载，按 URL 区分避免换源沿用旧状态
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const pressStartRef = useRef(null); // { x, y } long-press origin; tolerate tiny finger jitter

  // 长按 500ms 触发单页下载；只有明显移动(>10px)/抬起/离开才取消。
  // 用 setPointerCapture 锁定指针，配合 contextmenu 兜底，避免被 WebView/click 吃掉。
  const startLongPress = useCallback((e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    longPressTriggeredRef.current = false;
    clearTimeout(longPressTimerRef.current);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      pressStartRef.current = null;
      onLongPress?.(page);
    }, 500);
  }, [page, onLongPress]);

  const handlePointerMove = useCallback((e) => {
    const start = pressStartRef.current;
    if (!start) return;
    if (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10) {
      clearTimeout(longPressTimerRef.current);
      pressStartRef.current = null;
    }
  }, []);

  const cancelLongPress = useCallback(() => {
    pressStartRef.current = null;
    clearTimeout(longPressTimerRef.current);
  }, []);

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    if (e.button === 2) return;
    if (longPressTriggeredRef.current) return;
    longPressTriggeredRef.current = true;
    clearTimeout(longPressTimerRef.current);
    onLongPress?.(page);
  }, [page, onLongPress]);

  // 详情流始终显示 540px 等比预览，避免打开作品时出现空白或加载高分图。
  // 后续页必须使用本页预览，不得复用第 0 页缩略图。
  const bg = placeholderUrl || (page === 0
    ? (image?.thumbnailUrl || pixivReUrl(String(image.illustId), page))
    : '');
  // 详情流只展示 540px 预览图；原图只由灯箱按需加载。
  const src = previewUrl;
  const loaded = !!src && loadedSrc === src;
  const failed = !!src && failedSrc === src;
  const heroRatio = ratio || cachedRatio || defaultRatio || '3 / 4';

  return (
    <div
      ref={(node) => { registerRef?.(page, node); }}
      className="image-detail-hero"
      data-detail-anchor={`page-${page}`}
      onClick={() => {
        if (longPressTriggeredRef.current) {
          longPressTriggeredRef.current = false;
          return;
        }
        onOpenLightbox?.(page);
      }}
      onPointerDown={startLongPress}
      onPointerMove={handlePointerMove}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onContextMenu={handleContextMenu}
      /* 预览图加载完成后不再锁容器比例：高度完全由图片自身(--flow)决定，
         避免「容器比例(猜的/第 0 页的)」与真实图片比例不一致时，
         图片底部露出一条毛玻璃底色（模糊底图 + 卡片 backdrop-filter）。 */
      style={{ aspectRatio: loaded ? undefined : heroRatio, WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'pan-y' }}
    >
      {/* 这里不再铺一层模糊底图：它会和主图比例不一致时露出一条
          「模糊 + 压暗」的色带，看起来就是图片被毛玻璃盖住了一部分。 */}
      {!src ? (
        <>
          {bg && (
            <img
              className="image-detail-thumb-placeholder"
              src={bg}
              alt=""
              draggable={false}
            />
          )}
          {!bg && (
            <div className="image-detail-placeholder">
              <span className="image-detail-placeholder-spinner" />
            </div>
          )}
        </>
      ) : !failed ? (
        <>
          {bg && (
            <img
              className={`image-detail-thumb-placeholder${loaded ? ' is-hidden' : ''}`}
              src={bg}
              alt=""
              draggable={false}
            />
          )}
          {!loaded && !bg && (
            <div className="image-detail-placeholder">
              <span className="image-detail-placeholder-spinner" />
            </div>
          )}
          <img
            className={`image-detail-main image-detail-main--flow${loaded ? ' is-loaded' : ''}`}
            key={src}
            src={src}
            alt={`第 ${page + 1} 页`}
            loading="lazy"
            draggable={false}
            onLoad={(e) => {
              setLoadedSrc(src);
              const nw = e.currentTarget.naturalWidth;
              const nh = e.currentTarget.naturalHeight;
              const isSquareCrop = nw === nh && (nw === 540 || nw === 250);
              // 仅等比预览图参与宽高比校准，跳过 Pixiv 方形裁剪缩略图（540×540, 250×250）
              if (nw && nh && !isSquareCrop) {
                const nextRatio = `${nw} / ${nh}`;
                setRatio(nextRatio);
                onRatioReady?.(page, nextRatio);
              }
            }}
            onError={() => {
              log.warn('详情页预览图加载失败:', page, src?.slice(0, 120));
              setFailedSrc(src);
            }}
          />
        </>
      ) : (
        <div className="image-detail-error">加载失败</div>
      )}
      {/* 页数标注：直接标在本页图片右下角 */}
      {totalPages > 1 && (
        <span className="detail-hero-pages">{page + 1}/{totalPages}</span>
      )}
    </div>
  );
}
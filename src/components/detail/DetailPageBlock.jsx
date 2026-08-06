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
  defaultRatio,
  cachedRatio,
  registerRef,
  onOpenLightbox,
  onLongPress,
  onRatioReady,
}) {
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(null); // 预览图加载后按真实比例覆盖占位
  const [loaded, setLoaded] = useState(false); // 预览图是否加载完成（加载占位用）
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

  // 所有页用缩略图模糊铺底，第 0 页用 thumb，其他页更模糊
  // 缩略图铺底：优先网格带进来的真实缩略图；其他页兜底用 pixiv.re 原图短链（thumb 裁剪路径 404）
  const bg = image?.thumbnailUrl || pixivReUrl(String(image.illustId), page);
  const bgClass = page === 0 ? 'image-detail-bg' : 'image-detail-bg image-detail-bg--deep';
  // 展示图：已下载页 → 本地原图（blob）；未下载页 → 540px 等比预览（加载前只保留比例占位块）
  const src = previewUrl;
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
      style={{ aspectRatio: heroRatio, WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'pan-y' }}
    >
      {bg && <img className={bgClass} src={bg} alt="" draggable={false} />}
      {!src ? (
        // illustData 尚未加载，先显示转圈占位
        <div className="image-detail-placeholder">
          <span className="image-detail-placeholder-spinner" />
        </div>
      ) : !failed ? (
        <>
          {!loaded && (
            <div className="image-detail-placeholder">
              <span className="image-detail-placeholder-spinner" />
            </div>
          )}
          <img
            className="image-detail-main image-detail-main--flow"
            key={src}
            src={src}
            alt={`第 ${page + 1} 页`}
            loading="lazy"
            draggable={false}
            onLoad={(e) => {
              setLoaded(true);
              // 仅等比预览图参与宽高比校准，方形缩略图不参与
              if (previewUrl) {
                const nw = e.currentTarget.naturalWidth;
                const nh = e.currentTarget.naturalHeight;
                if (nw && nh) {
                  const nextRatio = `${nw} / ${nh}`;
                  setRatio(nextRatio);
                  onRatioReady?.(page, nextRatio);
                }
              }
            }}
            onError={() => {
              log.warn('详情页预览图加载失败:', page, src?.slice(0, 120));
              setFailed(true);
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

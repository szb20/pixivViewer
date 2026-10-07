import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivReUrl } from '../../pixiv-assistant/core/utils.js';
import { createLogger } from '../../utils/logger.js';
import { markImageLoaded } from '../../utils/loadedImages.js';

const log = createLogger('DetailPageBlock');

/**
 * 多图详情页的单页块 — 所有页面上下堆叠展示。
 * 进入视口时懒加载原图（本地相册优先 → 网络原图），
 * 原图就绪前用缩略图/等比预览铺底；点击打开灯箱；长按下载该页原图。
 *
 * hdUrl：桌面端传高清原图（本地原图或详情接口的原图直链）。
 * 预览先渲染保证秒开，原图到货后淡入覆盖；失败就保持预览，不打断阅读。
 * 手机端不传（流量/内存），行为与改动前一致。
 */
export default function DetailPageBlock({
  page,
  totalPages,
  image,
  previewUrl,
  hdUrl = '',
  placeholderUrl,
  defaultRatio,
  cachedRatio,
  previewNaturalWidth = 0,
  registerRef,
  onOpenLightbox,
  onLongPress,
  onRatioReady,
}) {
  const [failedSrc, setFailedSrc] = useState('');
  const [ratio, setRatio] = useState(null); // 预览图加载后按真实比例覆盖占位
  const [loadedSrc, setLoadedSrc] = useState(''); // 详情预览图是否已加载，按 URL 区分避免换源沿用旧状态
  const [hdLoaded, setHdLoaded] = useState(''); // 高清原图已加载的 URL（同上，按 URL 区分）
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const pressStartRef = useRef(null); // { x, y } long-press origin; tolerate tiny finger jitter
  const mainImgRef = useRef(null);
  const hdImgRef = useRef(null);

  // 卸载时丢掉未触发的长按：500ms 窗口内滑走/关闭详情，不该再弹出下载框
  useEffect(() => () => clearTimeout(longPressTimerRef.current), []);

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
  // pixivReUrl 只认 Pixiv 的 illustId：非 Pixiv 来源兜底为空，宁可空底也不拿同号 pixiv 图顶包。
  const isBooru = (image?.source || 'pixiv') !== 'pixiv';
  const bg = placeholderUrl || (page === 0
    ? (image?.thumbnailUrl || (isBooru ? '' : pixivReUrl(String(image.illustId), page)))
    : '');
  // 详情流只展示 540px 预览图；原图只由灯箱按需加载。
  const src = previewUrl;
  const loaded = !!src && loadedSrc === src;
  const failed = !!src && failedSrc === src;
  const heroRatio = ratio || cachedRatio || defaultRatio || '3 / 4';
  // 桌面端主图要按「一屏」收（高度见 ·detail.css 的 --detail-media-h）。
  // 这里把本页比例一并交给 CSS：未加载时容器只有 aspect-ratio 一个尺寸来源，
  // 宽度也得按同一个上限收，否则占位框先铺满整列、图到了再缩回去。
  // 长图/条漫（比 1:2 还窄）收不住也不该收 —— 缩到几百像素宽没法读，data-fit=0 放行高度。
  // 光有比例还不够：预览档位是「长边封顶」的等比图，竖图发出来只有 810 宽（1200×0.675），
  // 占位框按媒体列收到 1200 宽的话，图到了照样缩一下。--hero-w 就是这个像素宽度，
  // 由 ImageDetailView 按实际档位算好传进来（0 = 未知/原图，交给 CSS 兜底 100%）。
  const heroAr = (() => {
    const [w, h] = String(heroRatio).split('/').map(v => parseFloat(v));
    return w > 0 && h > 0 ? w / h : 0.75;
  })();

  // 预览图 load 的统一处理（onLoad 回调与下面的 complete 补查共用）
  const handlePreviewLoad = useCallback((el) => {
    markImageLoaded(src);
    setLoadedSrc(src);
    const nw = el.naturalWidth;
    const nh = el.naturalHeight;
    const isSquareCrop = nw === nh && (nw === 540 || nw === 250 || nw === 1200);
    // 仅等比预览图参与宽高比校准，跳过 Pixiv 方形裁剪缩略图（540×540, 250×250, 1200×1200）
    if (nw && nh && !isSquareCrop) {
      const nextRatio = `${nw} / ${nh}`;
      setRatio(nextRatio);
      onRatioReady?.(page, nextRatio);
    }
  }, [src, page, onRatioReady]);

  // 补挂载竞态：命中缓存的图可能在 React 收到 load 之前就已 complete，onLoad 丢失后
  // 预览永不淡入、高清图永远盖不上（同 GridItem.jsx 的处理；切页/重进作品时很常见）。
  useEffect(() => {
    const im = mainImgRef.current;
    if (!im || !src) return;
    if (!im.complete) return;
    if (im.naturalWidth > 0) handlePreviewLoad(im);
    else setFailedSrc(src); // complete 但没尺寸 = 已失败（缓存里的失败也走这里）
  }, [src, handlePreviewLoad]);

  useEffect(() => {
    const im = hdImgRef.current;
    if (!im || !hdUrl) return;
    if (!im.complete || im.naturalWidth <= 0) return;
    markImageLoaded(hdUrl);
    setHdLoaded(hdUrl);
  }, [hdUrl]);

  return (
    <div
      ref={(node) => { registerRef?.(page, node); }}
      className="image-detail-hero"
      data-detail-anchor={`page-${page}`}
      data-fit={heroAr < 0.5 ? '0' : '1'}
      onClick={(e) => {
        if (longPressTriggeredRef.current) {
          longPressTriggeredRef.current = false;
          return;
        }
        // 连击的第二下不打开灯箱。点缩略图进详情（或点相关推荐换作品）时，指针底下
        // 立刻换成这张图片，双击的第二下会被当成「点大图」——一次双击直接跳进全屏灯箱，
        // 详情页看着就是「根本没法点」。e.detail 由浏览器按系统双击间隔计数，正好覆盖这一窗口。
        if (e.detail > 1) return;
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
      style={{ aspectRatio: loaded ? undefined : heroRatio, '--hero-ar': String(heroAr), '--hero-w': previewNaturalWidth > 0 ? `${previewNaturalWidth}px` : '100%', WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'pan-y' }}
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
            ref={mainImgRef}
            src={src}
            alt={`第 ${page + 1} 页`}
            loading="lazy"
            draggable={false}
            onLoad={(e) => handlePreviewLoad(e.currentTarget)}
            onError={() => {
              log.warn('详情页预览图加载失败:', page, src?.slice(0, 120));
              setFailedSrc(src);
            }}
          />
          {/* 高清原图：懒加载（滚到附近才请求），到货后淡入盖在预览上。
              失败就静默保留预览——画面仍然可用，只是没升到原图 */}
          {hdUrl && (
            <img
              className={`image-detail-hd${hdLoaded === hdUrl ? ' is-loaded' : ''}`}
              ref={hdImgRef}
              src={hdUrl}
              alt=""
              loading="lazy"
              draggable={false}
              onLoad={() => { markImageLoaded(hdUrl); setHdLoaded(hdUrl); }}
              onError={() => log.debug('高清图加载失败，保留预览:', page, hdUrl.slice(0, 120))}
            />
          )}
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
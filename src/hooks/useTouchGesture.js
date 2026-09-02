/**
 * useTouchGesture — 图片灯箱触摸手势引擎 hook。
 *
 * 封装双击缩放、双指 pinch zoom、滑动翻页、惯性动画、
 * 弹簧回弹、边缘滑动等触摸交互逻辑。
 *
 * 提取自 ImageLightbox.jsx，供 MediaLightbox 统一管理图片/视频/动图灯箱的手势交互。
 *
 * @param {object} opts
 * @param {Array}  opts.images          — 图片数组（长度用于边界检测）
 * @param {number} opts.initialIndex    — 初始索引
 * @param {function} opts.onClose       — () => void 关闭回调
 * @param {function} opts.onIndexChange — (index) => void 索引变化回调
 * @param {boolean} opts.disableZoom    — 禁用缩放手势
 * @param {boolean} opts.disableSwipe   — 禁用滑动手势
 */
import { useState, useEffect, useCallback, useRef } from 'react';

export function useTouchGesture({
  images,
  initialIndex = 0,
  onClose,
  onIndexChange,
  disableZoom = false,
  disableSwipe = false,
}) {
  const [index, setIndex] = useState(initialIndex);
  const indexRef = useRef(index);
  indexRef.current = index;
  const [hideUI, setHideUI] = useState(false);
  const [closing, setClosing] = useState(false);

  const cur = images[index];
  const isGif = cur?.type === 'gif';
  const zoomDisabled = disableZoom || (cur?.type !== 'image' && cur?.type !== 'gif' && cur?.type !== undefined);
  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;

  // ── Refs ────────────────────────────────────────────────
  const overlayRef = useRef(null);
  const trackRef = useRef(null);
  const slideRefs = useRef([]);

  // 触摸状态
  const touchRef = useRef({ x: 0, y: 0, startX: 0, startY: 0 });
  const touchTimeRef = useRef(0);
  const lastTapRef = useRef(0);
  const lastTapTimeRef = useRef(0); // 触摸已处理时间戳，防止合成 click 重复触发
  const springRef = useRef(null);
  const trackAnimRef = useRef(null);

  // 缩放手势
  const pinchRef = useRef({
    scale: 1,
    x: 0, y: 0,
    fingers: 0,
    initialDist: 0,
    initialScale: 1,
    midX: 0, midY: 0,
    initialMidX: 0, initialMidY: 0,
    initialX: 0, initialY: 0,
  });

  // 速度追踪（最近几帧用于惯性计算）
  const velocityRef = useRef({
    vx: 0, vy: 0,
    lastX: 0, lastY: 0,
    lastTime: 0,
    history: [],
  });

  // 手势模式
  const touchActiveRef = useRef(false); // 触摸序列是否由本 overlay 的 touchstart 发起
  const mouseActiveRef = useRef(false); // 鼠标拖拽序列是否由本 overlay 的 mousedown 发起
  const edgeSwipeRef = useRef(false);
  const swipeModeRef = useRef(null); // 'nav' | 'dismiss' | null
  const gestureLockedRef = useRef(false); // 方向锁

  // ── State（仅用于触发 re-render 的值）──────────────────
  const [swipeOff, setSwipeOff] = useState(0);
  const [pinchScale, setPinchScale] = useState(1);
  const [pinchPan, setPinchPan] = useState({ x: 0, y: 0 });
  const [zoomTrans, setZoomTrans] = useState(false);

  // 用 ref 存透明度，避免 React 渲染延迟
  const overlayOpacityRef = useRef(1);
  const setOverlayOpacity = useCallback((val) => {
    overlayOpacityRef.current = val;
    if (overlayRef.current) overlayRef.current.style.opacity = String(val);
  }, []);

  // ── 工具函数 ─────────────────────────────────────────────
  const getCurSlideEl = useCallback(() => slideRefs.current[index], [index]);

  const cancelSpring = useCallback(() => {
    if (springRef.current) {
      cancelAnimationFrame(springRef.current);
      springRef.current = null;
    }
    // 中断图片的 CSS transition（缩放/拖拽惯性）
    const el = getCurSlideEl();
    if (el) {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      el.style.transition = 'none';
      el.style.transform = `scale(${pinchRef.current.scale}) translate(${m.m41 / pinchRef.current.scale}px, ${m.m42 / pinchRef.current.scale}px)`;
      pinchRef.current.x = m.m41;
      pinchRef.current.y = m.m42;
    }
    // 同时中断 track 的 CSS transition（翻页动画），直接判定归宿
    if (trackAnimRef.current) {
      trackAnimRef.current.cleanup();
      trackAnimRef.current = null;
    }
    const track = trackRef.current;
    if (track) {
      const tm = new DOMMatrixReadOnly(getComputedStyle(track).transform);
      const curPx = tm.m41;
      const vw = window.innerWidth;
      // 根据当前像素位置计算最近的页，距离过半就跳转
      const nearestIdx = Math.round(-curPx / vw);
      const clampedIdx = Math.max(0, Math.min(images.length - 1, nearestIdx));
      if (clampedIdx !== indexRef.current) {
        setIndex(clampedIdx);
        setSwipeOff(0);
        onIndexChange?.(clampedIdx);
      }
      track.style.transition = 'none';
      track.style.transform = `translateX(calc(-${clampedIdx * 100}%))`;
    }
  }, [getCurSlideEl, images.length, onIndexChange]);
  // index 通过 ref 访问避免级联重建；setIndex/setSwipeOff 是稳定 setter

  // 直接操作 track DOM 实现 60fps 滑动（绕过 React 渲染管线）
  const applyTrackSwipe = useCallback((offsetX) => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transform = `translateX(calc(-${index * 100}% + ${offsetX}px))`;
    track.style.transition = 'none';
  }, [index]);

  const resetTrackDOM = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transform = '';
    track.style.transition = '';
  }, []);

  // 直接操作 DOM 设置 transform，避免 React 重渲染延迟
  const applyTransform = useCallback((scale, pan, extraY = 0, slideEl) => {
    const el = slideEl || getCurSlideEl();
    if (!el) return;
    el.style.transform = `scale(${scale}) translate(${pan.x / scale}px, ${(pan.y + extraY) / scale}px)`;
    el.style.transition = 'none';
  }, [getCurSlideEl]);

  // 缓存 display size，手势期间避免重复读 clientWidth 触发强制重排
  const displaySizeCache = useRef({ key: -1, w: 300, h: 300 });

  const getDisplaySize = useCallback(() => {
    const el = getCurSlideEl();
    // slide 元素可能是包裹容器（图片含托底）→ 取其中真正的原图 <img> 读原始尺寸
    const img = el?.tagName === 'IMG' ? el : el?.querySelector('img.lightbox-img-full');
    const cacheKey = img ? img.src?.slice(-40) : -1;
    // 同一张图的 display size 不变，直接返回缓存
    if (cacheKey && displaySizeCache.current.key === cacheKey) {
      return displaySizeCache.current;
    }
    // 原始尺寸：优先图片自然尺寸；加载前用条目已知宽高（详情接口），保证加载前后双击结果一致
    const nw = img?.naturalWidth || cur?.width || 300;
    const nh = img?.naturalHeight || cur?.height || 300;
    const vw = window.innerWidth;
    const maxH = window.innerHeight * 0.75;
    const s = Math.min(vw / nw, maxH / nh);
    const result = { w: nw * s, h: nh * s, key: cacheKey };
    displaySizeCache.current = result;
    return result;
  }, [getCurSlideEl, cur]);

  // 计算最大平移量
  const getMaxPan = useCallback((scale) => {
    if (scale <= 1) return { x: 0, y: 0 };
    const ds = getDisplaySize();
    return {
      x: Math.max(0, (ds.w * scale - window.innerWidth) / 2),
      y: Math.max(0, (ds.h * scale - window.innerHeight) / 2),
    };
  }, [getDisplaySize]);

  // 硬限制平移范围
  const hardClamp = useCallback((pan, scale) => {
    if (scale <= 1) return { x: 0, y: 0 };
    const max = getMaxPan(scale);
    return {
      x: Math.max(-max.x, Math.min(max.x, pan.x)),
      y: Math.max(-max.y, Math.min(max.y, pan.y)),
    };
  }, [getMaxPan]);

  // 橡皮筋阻尼：越界越深，阻力越大（平滑曲线）
  const rubberBand = useCallback((distance, limit, strength = 0.3) => {
    if (limit <= 0) return 0;
    if (Math.abs(distance) <= limit) return distance;
    const sign = distance > 0 ? 1 : -1;
    const overshoot = Math.abs(distance) - limit;
    const damped = limit + Math.log1p(overshoot * strength) / strength;
    return sign * damped;
  }, []);

  // 应用拖动（带橡皮筋效果）
  const applyDrag = useCallback((rawPan, scale) => {
    if (scale <= 1) return { x: 0, y: 0 };
    const max = getMaxPan(scale);
    return {
      x: rubberBand(rawPan.x, max.x, 0.3),
      y: rubberBand(rawPan.y, max.y, 0.3),
    };
  }, [getMaxPan, rubberBand]);

  // ── 惯性动画（CSS transition，GPU 合成器线程，零 JS 开销）─────
  const startInertia = useCallback((initVx, initVy, scale) => {
    cancelSpring();
    const clamped = hardClamp({ x: pinchRef.current.x, y: pinchRef.current.y }, scale);

    if (Math.abs(initVx) < 0.3 && Math.abs(initVy) < 0.3) {
      pinchRef.current.x = clamped.x;
      pinchRef.current.y = clamped.y;
      setPinchPan(clamped);
      setPinchScale(scale);
      setZoomTrans(true);
      return;
    }

    // 用速度预估最终位置，clamp 到边界
    // 惯性距离 ≈ v / (1 - friction) ≈ v * 8（friction=0.875）
    const carryX = initVx * 8;
    const carryY = initVy * 8;
    const rawX = pinchRef.current.x + carryX;
    const rawY = pinchRef.current.y + carryY;
    const target = hardClamp({ x: rawX, y: rawY }, scale);

    pinchRef.current.x = target.x;
    pinchRef.current.y = target.y;
    setPinchPan(target);
    setPinchScale(scale);
    setZoomTrans(true);

    // CSS transition 在 GPU 合成器线程执行，不占 JS 主线程
    const el = getCurSlideEl();
    if (el) {
      el.style.transition = 'none';
      // 先设当前位置（消除可能残留的 transition）
      el.style.transform = `scale(${scale}) translate(${clamped.x / scale}px, ${clamped.y / scale}px)`;
      // 强制刷新样式，然后设目标 + 开 transition
      el.getBoundingClientRect();
      el.style.transition = 'transform 0.45s cubic-bezier(0.16, 0.72, 0.24, 1)';
      el.style.transform = `scale(${scale}) translate(${target.x / scale}px, ${target.y / scale}px)`;
    }
  }, [cancelSpring, hardClamp, getCurSlideEl]);

  // ── 缩放过渡动画（CSS transition，GPU 合成器线程）─────────
  const springBack = useCallback((fromScale, fromX, fromY, toScale, toX, toY) => {
    cancelSpring();
    const el = getCurSlideEl();
    pinchRef.current.scale = toScale;
    pinchRef.current.x = toX;
    pinchRef.current.y = toY;
    setPinchScale(toScale);
    setPinchPan({ x: toX, y: toY });
    setZoomTrans(true);

    if (el) {
      el.style.transition = 'none';
      el.style.transform = `scale(${fromScale}) translate(${fromX / fromScale}px, ${fromY / fromScale}px)`;
      el.getBoundingClientRect(); // 强制样式刷新
      el.style.transition = 'transform 0.35s cubic-bezier(0.16, 0.72, 0.24, 1)';
      el.style.transform = `scale(${toScale}) translate(${toX / toScale}px, ${toY / toScale}px)`;
    }
  }, [cancelSpring, getCurSlideEl]);

  // ── 导航 ─────────────────────────────────────────────────
  const nav = useCallback((dir) => {
    const newIdx = index + dir;
    if (newIdx >= 0 && newIdx < images.length) {
      cancelSpring();
      edgeSwipeRef.current = false;
      swipeModeRef.current = null;
      gestureLockedRef.current = false;
      setIndex(newIdx);
      setPinchScale(1);
      setPinchPan({ x: 0, y: 0 });
      setSwipeOff(0);
      setOverlayOpacity(1);
      pinchRef.current.scale = 1;
      pinchRef.current.x = 0;
      pinchRef.current.y = 0;
      onIndexChange?.(newIdx);
    }
  }, [index, images.length, cancelSpring, setOverlayOpacity, onIndexChange]);

  // 同作品多页导航
  const findAdjacentPage = useCallback((dir) => {
    if (!cur || !cur._totalPages || cur._totalPages <= 1) return -1;
    const targetPage = (cur._pageIndex || 0) + dir;
    // 在整个数组中搜索同 illustId 的目标页码（处理页面不连续排列的情况）
    for (let i = 0; i < images.length; i++) {
      const item = images[i];
      if (item.illustId === cur.illustId && (item._pageIndex || 0) === targetPage) {
        return i;
      }
    }
    return -1;
  }, [cur, images]);

  const navPage = useCallback((dir) => {
    const idx = findAdjacentPage(dir);
    if (idx >= 0) {
      cancelSpring();
      setIndex(idx);
      setPinchScale(1);
      setPinchPan({ x: 0, y: 0 });
      pinchRef.current.scale = 1;
      pinchRef.current.x = 0;
      pinchRef.current.y = 0;
      onIndexChange?.(idx);
    }
  }, [findAdjacentPage, cancelSpring, onIndexChange]);

  // ── 滑动翻页动画（CSS transition）──────────────────────
  const animateNavSwipe = useCallback((dir) => {
    if (trackAnimRef.current) { trackAnimRef.current.cleanup(); trackAnimRef.current = null; }
    const newIdx = index + dir;
    const track = trackRef.current;
    if (!track || newIdx < 0 || newIdx >= images.length) {
      if (track) {
        track.style.transform = `translateX(calc(-${index * 100}%))`;
        track.style.transition = 'transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)';
      }
      setSwipeOff(0);
      return;
    }
    let ended = false;
    const onEnd = () => {
      if (ended) return; ended = true;
      track.removeEventListener('transitionend', onEnd);
      clearTimeout(safetyId);
      trackAnimRef.current = null;
      nav(dir);
    };
    track.addEventListener('transitionend', onEnd);
    const safetyId = setTimeout(onEnd, 650);
    trackAnimRef.current = {
      cleanup: () => { track.removeEventListener('transitionend', onEnd); clearTimeout(safetyId); },
    };
    track.style.transition = 'transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)';
    track.style.transform = `translateX(calc(-${newIdx * 100}%))`;
  }, [index, images.length, nav]);

  // ── 关闭 ─────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    if (closing) return;
    cancelSpring();
    setClosing(true);
    setOverlayOpacity(0);
    setTimeout(() => {
      onClose?.();
    }, 250);
  }, [closing, cancelSpring, setOverlayOpacity, onClose]);

  // ── 双击缩放 ─────────────────────────────────────────────
  const handleDoubleTap = useCallback((e) => {
    if (zoomDisabled) return;
    cancelSpring();

    const el = getCurSlideEl();
    const curScale = pinchRef.current.scale;
    if (curScale > 1.05) {
      // 已放大 → 缩回 1x
      springBack(curScale, pinchRef.current.x, pinchRef.current.y, 1, 0, 0);
    } else {
      // 1x → 自适应倍率：以图片原始分辨率为基准，尽量让 1 图像像素 ≈ 1 屏幕像素
      if (!el) return;
      const img = el.tagName === 'IMG' ? el : el.querySelector('img.lightbox-img-full');
      const nw = img?.naturalWidth || cur?.width || 300;
      const nh = img?.naturalHeight || cur?.height || 300;
      const ds = getDisplaySize();
      // displayScale：图片原尺寸到屏幕显示尺寸的缩放比
      // displayScale < 1 → 图片被缩小显示（高分辨率图）
      // displayScale > 1 → 图片被放大显示（小缩略图）
      const displayScale = Math.min(ds.w / nw, ds.h / nh);
      // 目标倍率 = 1 / displayScale，使显示像素 ≈ 原始像素，限制在 2x ~ 3x
      const toScale = Math.max(2, Math.min(3, Math.round(1 / displayScale)));

      const rect = el.getBoundingClientRect();
      const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
      const tapX = touch.clientX - rect.left - rect.width / 2;
      const tapY = touch.clientY - rect.top - rect.height / 2;

      const rawPan = {
        x: -tapX * (toScale / curScale - 1) * curScale,
        y: -tapY * (toScale / curScale - 1) * curScale,
      };
      const clamped = hardClamp(rawPan, toScale);

      springBack(curScale, pinchRef.current.x, pinchRef.current.y, toScale, clamped.x, clamped.y);
    }
  }, [zoomDisabled, cancelSpring, springBack, getCurSlideEl, hardClamp, getDisplaySize, cur]);

  // ── 触摸事件 ─────────────────────────────────────────────
  const handleTouchStart = useCallback((e) => {
    e.stopPropagation();
    if (zoomDisabled && disableSwipe) return;

    touchActiveRef.current = true;
    cancelSpring();
    if (trackAnimRef.current) { trackAnimRef.current.cleanup(); resetTrackDOM(); trackAnimRef.current = null; }

    edgeSwipeRef.current = false;
    swipeModeRef.current = null;
    gestureLockedRef.current = false;

    const touches = e.touches;
    pinchRef.current.fingers = touches.length;

    if (touches.length === 1) {
      const t = touches[0];
      touchRef.current = { x: t.clientX, y: t.clientY, startX: t.clientX, startY: t.clientY };
      touchTimeRef.current = Date.now();
      setSwipeOff(0);
      setOverlayOpacity(1);

      velocityRef.current = {
        vx: 0, vy: 0,
        lastX: t.clientX,
        lastY: t.clientY,
        lastTime: Date.now(),
        history: [],
      };

    } else if (touches.length === 2 && !zoomDisabled) {
      swipeModeRef.current = null;
      gestureLockedRef.current = true;
      setOverlayOpacity(1);

      const el = getCurSlideEl();
      if (el) { el.style.transition = 'none'; }

      const dx = touches[1].clientX - touches[0].clientX;
      const dy = touches[1].clientY - touches[0].clientY;
      const dist = Math.hypot(dx, dy);
      const midX = (touches[0].clientX + touches[1].clientX) / 2;
      const midY = (touches[0].clientY + touches[1].clientY) / 2;

      pinchRef.current.initialDist = dist;
      pinchRef.current.initialScale = pinchRef.current.scale;
      pinchRef.current.initialMidX = midX;
      pinchRef.current.initialMidY = midY;
      pinchRef.current.initialX = pinchRef.current.x;
      pinchRef.current.initialY = pinchRef.current.y;
      pinchRef.current.midX = midX;
      pinchRef.current.midY = midY;
    }
  }, [zoomDisabled, disableSwipe, cancelSpring, setOverlayOpacity, getCurSlideEl, resetTrackDOM]);

  const handleTouchMove = useCallback((e) => {
    e.stopPropagation();
    if (!touchActiveRef.current) return;
    // touch-action: none 在 CSS .lightbox-overlay 已设置，无需 preventDefault
    if (zoomDisabled && disableSwipe) return;

    if (e.touches.length === 2 && !zoomDisabled) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.hypot(dx, dy);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

      if (pinchRef.current.initialDist > 30 && dist > 30) {
        const ratio = dist / pinchRef.current.initialDist;
        let newScale = pinchRef.current.initialScale * ratio;

        if (newScale < 1) {
          newScale = 1 - rubberBand(1 - newScale, 0.5, 2);
        } else if (newScale > 5) {
          newScale = 5 + rubberBand(newScale - 5, 1, 2);
        }
        newScale = Math.max(0.5, Math.min(6, newScale));

        const scaleDelta = newScale / pinchRef.current.initialScale;
        const midDeltaX = midX - pinchRef.current.initialMidX;
        const midDeltaY = midY - pinchRef.current.initialMidY;

        const newX = pinchRef.current.initialX * scaleDelta - midDeltaX * (scaleDelta - 1);
        const newY = pinchRef.current.initialY * scaleDelta - midDeltaY * (scaleDelta - 1);

        let clampedX = newX;
        let clampedY = newY;
        if (newScale >= 1 && newScale <= 5) {
          const max = getMaxPan(newScale);
          clampedX = Math.max(-max.x, Math.min(max.x, newX));
          clampedY = Math.max(-max.y, Math.min(max.y, newY));
        }

        pinchRef.current.scale = newScale;
        pinchRef.current.x = clampedX;
        pinchRef.current.y = clampedY;
        pinchRef.current.midX = midX;
        pinchRef.current.midY = midY;

        applyTransform(newScale, { x: clampedX, y: clampedY });
      }
      return;
    }

    if (e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - touchRef.current.x;
      const dy = t.clientY - touchRef.current.y;
      const totalDx = t.clientX - touchRef.current.startX;
      const totalDy = t.clientY - touchRef.current.startY;
      const now = Date.now();
      const dt = now - velocityRef.current.lastTime;

      if (dt > 0) {
        velocityRef.current.history.push({ vx: dx, vy: dy, dt: dt });
        if (velocityRef.current.history.length > 5) {
          velocityRef.current.history.shift();
        }
      }
      velocityRef.current.lastX = t.clientX;
      velocityRef.current.lastY = t.clientY;
      velocityRef.current.lastTime = now;

      const scale = pinchRef.current.scale;

      if (scale > 1 && !zoomDisabled) {
        const rawPan = {
          x: pinchRef.current.x + dx,
          y: pinchRef.current.y + dy,
        };

        const max = getMaxPan(scale);
        // 用阻尼前的 raw 坐标判断边缘，避免橡皮筋阻止边缘触发
        const atLeftEdge = rawPan.x < -max.x;
        const atRightEdge = rawPan.x > max.x;

        if ((atLeftEdge && dx > 0) || (atRightEdge && dx < 0)) {
          if (!edgeSwipeRef.current && Math.abs(totalDx) > 30) {
            edgeSwipeRef.current = true;
          }
        } else if (edgeSwipeRef.current && Math.abs(totalDx) < 20) {
          edgeSwipeRef.current = false;
        }

        const damped = applyDrag(rawPan, scale);
        pinchRef.current.x = damped.x;
        pinchRef.current.y = damped.y;
        applyTransform(scale, damped);

      } else if (!disableSwipe && !gestureLockedRef.current) {
        if (Math.abs(totalDx) > 20 && Math.abs(totalDx) > Math.abs(totalDy)) {
          swipeModeRef.current = 'nav';
          gestureLockedRef.current = true;
        }
      }

      if (!disableSwipe && gestureLockedRef.current && swipeModeRef.current === 'nav') {
        applyTrackSwipe(totalDx);
      }

      touchRef.current.x = t.clientX;
      touchRef.current.y = t.clientY;
    }
  }, [zoomDisabled, disableSwipe, getMaxPan, applyDrag, applyTransform, rubberBand, applyTrackSwipe]);

  const handleTouchEnd = useCallback((e) => {
    e.stopPropagation();
    if (!touchActiveRef.current) return;
    touchActiveRef.current = false;
    if (zoomDisabled && disableSwipe) return;

    const now = Date.now();
    const tapDur = now - touchTimeRef.current;
    const totalDx = touchRef.current.x - touchRef.current.startX;
    const totalDy = touchRef.current.y - touchRef.current.startY;
    const moved = Math.hypot(totalDx, totalDy);

    // ── 双击检测 ──
    const prevLastTap = lastTapRef.current;
    if (pinchRef.current.fingers <= 1 && tapDur < 200 && e.changedTouches.length === 1 && moved < 15) {
      if (now - prevLastTap < 350) {
        handleDoubleTap(e);
        lastTapRef.current = 0;
        pinchRef.current.fingers = 0;
        return;
      }
      lastTapRef.current = now;
    }

    const scale = pinchRef.current.scale;

    // ── 双指缩放结束 ──
    if (e.changedTouches.length === 2 || pinchRef.current.fingers === 2) {
      let finalScale = scale;
      if (finalScale < 1) {
        springBack(finalScale, pinchRef.current.x, pinchRef.current.y, 1, 0, 0);
      } else if (finalScale > 5) {
        const clamped = hardClamp({ x: pinchRef.current.x, y: pinchRef.current.y }, 5);
        springBack(finalScale, pinchRef.current.x, pinchRef.current.y, 5, clamped.x, clamped.y);
      } else {
        const clamped = hardClamp({ x: pinchRef.current.x, y: pinchRef.current.y }, finalScale);
        pinchRef.current.x = clamped.x;
        pinchRef.current.y = clamped.y;
        setPinchScale(finalScale);
        setPinchPan(clamped);
        setZoomTrans(true);
      }
      pinchRef.current.fingers = 0;
      return;
    }

    // ── 单指缩放拖动结束 ──
    if (scale > 1 && !zoomDisabled) {
      if (edgeSwipeRef.current && !disableSwipe) {
        edgeSwipeRef.current = false;
        const velocity = velocityRef.current.history.length > 0
          ? velocityRef.current.history.reduce((s, h) => s + h.vx, 0) / velocityRef.current.history.length
          : 0;

        if (Math.abs(totalDx) > 60 || Math.abs(velocity) > 3) {
          nav(totalDx > 0 ? -1 : 1);
          return;
        }
      }

      let finalScale = scale;
      if (finalScale < 1) finalScale = 1;
      if (finalScale > 5) finalScale = 5;

      let avgVx = 0, avgVy = 0;
      const hist = velocityRef.current.history;
      if (hist.length > 0) {
        let totalWeight = 0;
        for (let i = 0; i < hist.length; i++) {
          const weight = i + 1;
          avgVx += hist[i].vx * weight;
          avgVy += hist[i].vy * weight;
          totalWeight += weight;
        }
        avgVx /= totalWeight;
        avgVy /= totalWeight;
      }

      const clamped = hardClamp({ x: pinchRef.current.x, y: pinchRef.current.y }, finalScale);
      pinchRef.current.scale = finalScale;
      pinchRef.current.x = clamped.x;
      pinchRef.current.y = clamped.y;

      if (Math.abs(avgVx) > 1 || Math.abs(avgVy) > 1) {
        setPinchScale(finalScale);
        setPinchPan(clamped);
        setZoomTrans(true);
        startInertia(avgVx, avgVy, finalScale);
      } else {
        setPinchScale(finalScale);
        setPinchPan(clamped);
        setZoomTrans(true);
      }

      pinchRef.current.fingers = 0;
      return;
    }

    // ── 未缩放时的手势结束 ──
    if (!disableSwipe && gestureLockedRef.current) {
      if (swipeModeRef.current === 'nav') {
        const avgVx = velocityRef.current.history.reduce((s, h) => s + h.vx, 0) / (velocityRef.current.history.length || 1);

        if (Math.abs(totalDx) > 60 || Math.abs(avgVx) > 3) {
          animateNavSwipe(totalDx > 0 ? -1 : 1);
        } else {
          const track = trackRef.current;
          if (track) {
            track.style.transform = `translateX(calc(-${index * 100}% + 0px))`;
            track.style.transition = 'transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)';
          }
          setSwipeOff(0);
        }
        swipeModeRef.current = null;
        gestureLockedRef.current = false;
        pinchRef.current.fingers = 0;
        return;
      }
    }

    // ── 单击：切换 UI 显隐 ──
    if (tapDur < 200 && moved < 10 && now - prevLastTap > 350) {
      if (!e.target.closest('button, a')) {
        lastTapTimeRef.current = now;
        setHideUI(h => !h);
      }
    }

    pinchRef.current.fingers = 0;
  }, [zoomDisabled, disableSwipe, handleDoubleTap, nav, springBack, hardClamp, startInertia, animateNavSwipe, index]);

  // ── 鼠标手势（桌面端）───────────────────────────────────
  // 仅处理真实鼠标事件：排除触摸设备上浏览器合成的 mousedown，避免与 touch 手势重复触发
  const isInteractiveTarget = useCallback((target) => {
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest('video, iframe, button, a, .video-player-wrapper, .video-embed-iframe, .quality-selector');
  }, []);

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return; // 仅左键
    if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
    if (isInteractiveTarget(e.target)) return;
    e.stopPropagation();
    if (zoomDisabled && disableSwipe) return;

    mouseActiveRef.current = true;
    touchActiveRef.current = true;

    cancelSpring();
    if (trackAnimRef.current) { trackAnimRef.current.cleanup(); resetTrackDOM(); trackAnimRef.current = null; }

    edgeSwipeRef.current = false;
    swipeModeRef.current = null;
    gestureLockedRef.current = false;
    pinchRef.current.fingers = 1;

    touchRef.current = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY };
    touchTimeRef.current = Date.now();
    setSwipeOff(0);
    setOverlayOpacity(1);

    velocityRef.current = {
      vx: 0, vy: 0,
      lastX: e.clientX,
      lastY: e.clientY,
      lastTime: Date.now(),
      history: [],
    };
  }, [zoomDisabled, disableSwipe, cancelSpring, setOverlayOpacity, resetTrackDOM, isInteractiveTarget]);

  const handleMouseMove = useCallback((e) => {
    e.stopPropagation();
    if (!mouseActiveRef.current || !touchActiveRef.current) return;
    if (zoomDisabled && disableSwipe) return;

    const dx = e.clientX - touchRef.current.x;
    const dy = e.clientY - touchRef.current.y;
    const totalDx = e.clientX - touchRef.current.startX;
    const totalDy = e.clientY - touchRef.current.startY;
    const now = Date.now();
    const dt = now - velocityRef.current.lastTime;

    if (dt > 0) {
      velocityRef.current.history.push({ vx: dx, vy: dy, dt: dt });
      if (velocityRef.current.history.length > 5) {
        velocityRef.current.history.shift();
      }
    }
    velocityRef.current.lastX = e.clientX;
    velocityRef.current.lastY = e.clientY;
    velocityRef.current.lastTime = now;

    const scale = pinchRef.current.scale;

    if (scale > 1 && !zoomDisabled) {
      const rawPan = {
        x: pinchRef.current.x + dx,
        y: pinchRef.current.y + dy,
      };
      const max = getMaxPan(scale);
      const atLeftEdge = rawPan.x < -max.x;
      const atRightEdge = rawPan.x > max.x;

      if ((atLeftEdge && dx > 0) || (atRightEdge && dx < 0)) {
        if (!edgeSwipeRef.current && Math.abs(totalDx) > 30) {
          edgeSwipeRef.current = true;
        }
      } else if (edgeSwipeRef.current && Math.abs(totalDx) < 20) {
        edgeSwipeRef.current = false;
      }

      const damped = applyDrag(rawPan, scale);
      pinchRef.current.x = damped.x;
      pinchRef.current.y = damped.y;
      applyTransform(scale, damped);
    } else if (!disableSwipe && !gestureLockedRef.current) {
      if (Math.abs(totalDx) > 20 && Math.abs(totalDx) > Math.abs(totalDy)) {
        swipeModeRef.current = 'nav';
        gestureLockedRef.current = true;
      }
    }

    if (!disableSwipe && gestureLockedRef.current && swipeModeRef.current === 'nav') {
      applyTrackSwipe(totalDx);
    }

    touchRef.current.x = e.clientX;
    touchRef.current.y = e.clientY;
  }, [zoomDisabled, disableSwipe, getMaxPan, applyDrag, applyTransform, applyTrackSwipe]);

  const handleMouseUp = useCallback((e) => {
    e.stopPropagation();
    if (!mouseActiveRef.current || !touchActiveRef.current) return;
    mouseActiveRef.current = false;
    touchActiveRef.current = false;
    if (zoomDisabled && disableSwipe) return;

    const totalDx = touchRef.current.x - touchRef.current.startX;
    const scale = pinchRef.current.scale;

    // ── 缩放后的拖拽结束 ──
    if (scale > 1 && !zoomDisabled) {
      if (edgeSwipeRef.current && !disableSwipe) {
        edgeSwipeRef.current = false;
        const velocity = velocityRef.current.history.length > 0
          ? velocityRef.current.history.reduce((s, h) => s + h.vx, 0) / velocityRef.current.history.length
          : 0;

        if (Math.abs(totalDx) > 60 || Math.abs(velocity) > 3) {
          nav(totalDx > 0 ? -1 : 1);
          return;
        }
      }

      let finalScale = scale;
      if (finalScale < 1) finalScale = 1;
      if (finalScale > 5) finalScale = 5;

      let avgVx = 0, avgVy = 0;
      const hist = velocityRef.current.history;
      if (hist.length > 0) {
        let totalWeight = 0;
        for (let i = 0; i < hist.length; i++) {
          const weight = i + 1;
          avgVx += hist[i].vx * weight;
          avgVy += hist[i].vy * weight;
          totalWeight += weight;
        }
        avgVx /= totalWeight;
        avgVy /= totalWeight;
      }

      const clamped = hardClamp({ x: pinchRef.current.x, y: pinchRef.current.y }, finalScale);
      pinchRef.current.scale = finalScale;
      pinchRef.current.x = clamped.x;
      pinchRef.current.y = clamped.y;

      if (Math.abs(avgVx) > 1 || Math.abs(avgVy) > 1) {
        setPinchScale(finalScale);
        setPinchPan(clamped);
        setZoomTrans(true);
        startInertia(avgVx, avgVy, finalScale);
      } else {
        setPinchScale(finalScale);
        setPinchPan(clamped);
        setZoomTrans(true);
      }

      pinchRef.current.fingers = 0;
      return;
    }

    // ── 未缩放时的翻页手势结束 ──
    if (!disableSwipe && gestureLockedRef.current) {
      if (swipeModeRef.current === 'nav') {
        const avgVx = velocityRef.current.history.reduce((s, h) => s + h.vx, 0) / (velocityRef.current.history.length || 1);

        if (Math.abs(totalDx) > 60 || Math.abs(avgVx) > 3) {
          animateNavSwipe(totalDx > 0 ? -1 : 1);
        } else {
          if (trackRef.current) {
            trackRef.current.style.transform = `translateX(calc(-${index * 100}% + 0px))`;
            trackRef.current.style.transition = 'transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)';
          }
          setSwipeOff(0);
        }
      }
      swipeModeRef.current = null;
      gestureLockedRef.current = false;
      pinchRef.current.fingers = 0;
      return;
    }

    pinchRef.current.fingers = 0;
  }, [zoomDisabled, disableSwipe, nav, hardClamp, startInertia, animateNavSwipe, index, setPinchScale, setPinchPan, setZoomTrans]);

  // ── 滚轮缩放（以光标为锚点）─────────────────────────────
  const handleWheel = useCallback((e) => {
    if (zoomDisabled) return;
    if (isInteractiveTarget(e.target)) return;
    e.stopPropagation();
    cancelSpring();

    const curScale = pinchRef.current.scale;
    const factor = Math.exp(-e.deltaY * 0.002);
    let newScale = curScale * factor;
    newScale = Math.max(1, Math.min(6, newScale));

    const el = getCurSlideEl();
    const rect = el?.getBoundingClientRect();
    if (!rect) return;

    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    const scaleDelta = newScale / curScale;

    if (newScale <= 1) {
      pinchRef.current.scale = 1;
      pinchRef.current.x = 0;
      pinchRef.current.y = 0;
      setPinchScale(1);
      setPinchPan({ x: 0, y: 0 });
      setZoomTrans(false);
      return;
    }

    const rawX = pinchRef.current.x + px * (1 - scaleDelta);
    const rawY = pinchRef.current.y + py * (1 - scaleDelta);
    const clamped = hardClamp({ x: rawX, y: rawY }, newScale);

    pinchRef.current.scale = newScale;
    pinchRef.current.x = clamped.x;
    pinchRef.current.y = clamped.y;
    setPinchScale(newScale);
    setPinchPan(clamped);
    setZoomTrans(true);
  }, [zoomDisabled, isInteractiveTarget, cancelSpring, getCurSlideEl, hardClamp]);

  // ── 鼠标双击缩放 ─────────────────────────────────────────
  const handleDoubleClick = useCallback((e) => {
    if (zoomDisabled) return;
    if (isInteractiveTarget(e.target)) return;
    e.stopPropagation();
    handleDoubleTap(e);
  }, [zoomDisabled, isInteractiveTarget, handleDoubleTap]);

  // ── 点击遮罩 ─────────────────────────────────────────────
  const handleOverlayClick = useCallback((e) => {
    if (e.target === e.currentTarget) {
      // 触摸事件已处理过（touchend 先于合成 click 触发），跳过避免二次 toggle
      if (Date.now() - lastTapTimeRef.current < 500) return;
      setHideUI(h => !h);
    }
  }, []);

  // ── 键盘导航 ─────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') { handleClose(); return; }
      if (e.key === 'ArrowLeft' && hasPrev) nav(-1);
      if (e.key === 'ArrowRight' && hasNext) nav(1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasPrev, hasNext, nav, handleClose]);

  // ── 组件卸载时清理 ───────────────────────────────────────
  useEffect(() => {
    return () => { cancelSpring(); };
  }, [cancelSpring]);

  return {
    // DOM refs
    overlayRef, trackRef, slideRefs,

    // State
    index, closing, hideUI, setHideUI,
    swipeOff, pinchScale, pinchPan, zoomTrans,

    // Derived
    cur, isGif, hasPrev, hasNext,

    // Handlers
    handleTouchStart, handleTouchMove, handleTouchEnd,
    handleMouseDown, handleMouseMove, handleMouseUp,
    handleWheel, handleDoubleClick,
    handleClose, handleOverlayClick, handleDoubleTap,
    nav, navPage, findAdjacentPage, cancelSpring,
    applyTransform,
  };
}
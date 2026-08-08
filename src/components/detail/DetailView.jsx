import { useCallback, useEffect, useRef, useState } from 'react';
import ImageDetailView from './ImageDetailView.jsx';
import { registerBackHandler } from '../../utils/backHandler.js';
import { createLogger } from '../../utils/logger.js';
import { getDetailScrollEl } from '../../utils/scroll.js';
import { showToast } from '../../utils/toast.js';
import BackIcon from '../icons/BackIcon.jsx';

const log = createLogger('DetailView');

const scrollKeyOf = (img) => (
  img?.illustId ? `${img.illustId}:${img._pageIndex ?? 0}` : ''
);

const navKeyOf = (img) => (
  img?.illustId ? `${img.illustId}:${img._pageIndex ?? img.pageIndex ?? 0}` : ''
);

const SWIPE_TRIGGER_PX = 72;
const SWIPE_DIRECTION_RATIO = 1.35;
const SLIDE_ANIMATION_MS = 260;

const normalizeNavState = (img, navContext) => {
  const items = Array.isArray(navContext?.items) ? navContext.items.filter(Boolean) : [];
  if (!items.length) return { items: [], index: -1 };
  const currentKey = navKeyOf(img);
  let index = Number.isInteger(navContext?.index) ? navContext.index : -1;
  if (index < 0 || index >= items.length || navKeyOf(items[index]) !== currentKey) {
    index = items.findIndex(item => navKeyOf(item) === currentKey);
  }
  return { items, index };
};

const isInteractiveTarget = (target) => (
  target?.closest?.('button,a,input,textarea,select,[contenteditable="true"],[data-detail-ignore-swipe]')
);

const captureScrollAnchor = () => {
  const root = getDetailScrollEl();
  if (!root) return { top: 0, anchor: null };
  const rootTop = root.getBoundingClientRect().top;
  const blocks = [...root.querySelectorAll('[data-detail-anchor]')];
  let best = null;
  for (const node of blocks) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= rootTop) continue;
    best = {
      id: node.dataset.detailAnchor,
      delta: rect.top - rootTop,
    };
    break;
  }
  return { top: root.scrollTop || 0, anchor: best };
};

/**
 * 详情页包装 — 管理"当前作品"切换栈：
 * 相关推荐点图 → 压栈切换；返回键 → 弹栈，栈空则关闭详情页。
 */
export default function DetailView({ image: initialImage, navContext, onClose, onExitToHome, onSearchTag, onAuthorWorks }) {
  const [image, setImage] = useState(initialImage);
  const [restoreState, setRestoreState] = useState({ top: 0, anchor: null });
  const [openTransition, setOpenTransition] = useState(null);
  const [slideDirection, setSlideDirection] = useState(0);
  const stackRef = useRef([initialImage]);
  const navStateRef = useRef(normalizeNavState(initialImage, navContext));
  const navStateMapRef = useRef({});
  const swipeRef = useRef(null);
  const slideTimerRef = useRef(null);
  const handleBackRef = useRef(null);
  const scrollMapRef = useRef({}); // `${illustId}:${pageIndex}` → { top, anchor }
  const detailBgUrl = image?.thumbnailUrl || image?.previewUrl || image?.mediumUrl || image?.url || '';

  // 外部 prop 变化（从列表/推荐直接打开新作品）→ 重置栈
  useEffect(() => {
    if (initialImage?.illustId !== stackRef.current[stackRef.current.length - 1]?.illustId) {
      stackRef.current = [initialImage];
      navStateRef.current = normalizeNavState(initialImage, navContext);
      navStateMapRef.current = {};
      setImage(initialImage);
      setRestoreState({ top: 0, anchor: null });
    }
  }, [initialImage, navContext]);

  useEffect(() => {
    const from = initialImage?._openTransition;
    if (!from?.rect || !from.src) return;
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (prefersReducedMotion) return;

    const targetWidth = Math.min(window.innerWidth, 560);
    const fallbackTarget = {
      left: (window.innerWidth - targetWidth) / 2,
      top: Math.max(0, window.innerHeight * 0.12),
      width: targetWidth,
      height: Math.min(window.innerHeight * 0.62, from.rect.height * 1.8),
    };
    const base = { src: from.src, from: from.rect, to: fallbackTarget, active: false };
    setOpenTransition(base);

    let raf1 = 0;
    let raf2 = 0;
    const timer = setTimeout(() => setOpenTransition(null), 430);
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const target = document.querySelector('.image-detail-hero')?.getBoundingClientRect?.();
        setOpenTransition({
          ...base,
          active: true,
          to: target
            ? { left: target.left, top: target.top, width: target.width, height: target.height }
            : fallbackTarget,
        });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [initialImage]);

  const getCurrentScrollState = useCallback(() => captureScrollAnchor(), []);

  const rememberCurrentState = useCallback(() => {
    const cur = stackRef.current[stackRef.current.length - 1];
    const curKey = scrollKeyOf(cur);
    if (!curKey) return;
    scrollMapRef.current[curKey] = getCurrentScrollState();
    navStateMapRef.current[curKey] = navStateRef.current;
  }, [getCurrentScrollState]);

  const switchToImage = useCallback((next, restore = { top: 0, anchor: null }, direction = 0) => {
    if (!next) return;
    if (direction) {
      clearTimeout(slideTimerRef.current);
      setSlideDirection(0);
      requestAnimationFrame(() => {
        setSlideDirection(direction);
        slideTimerRef.current = window.setTimeout(() => setSlideDirection(0), SLIDE_ANIMATION_MS);
      });
    }
    stackRef.current[stackRef.current.length - 1] = next;
    setRestoreState(restore);
    setImage(next);
  }, []);

  const handleSelect = (img, context = null) => {
    if (!img) return;
    const cur = stackRef.current[stackRef.current.length - 1];
    rememberCurrentState();
    log.info('push:', cur?.illustId, 'stack:', stackRef.current.length, '→', img.illustId);
    stackRef.current.push(img);
    navStateRef.current = normalizeNavState(img, context);
    setRestoreState({ top: 0, anchor: null });
    setImage(img);
  };

  const handleSibling = useCallback((delta) => {
    const { items } = navStateRef.current;
    if (!items.length) {
      showToast('当前没有可左右切换的列表', { type: 'info' });
      return;
    }
    const cur = stackRef.current[stackRef.current.length - 1];
    const currentKey = navKeyOf(cur);
    const currentIndex = items.findIndex(item => navKeyOf(item) === currentKey);
    const baseIndex = currentIndex >= 0 ? currentIndex : navStateRef.current.index;
    const nextIndex = baseIndex + delta;
    if (nextIndex < 0 || nextIndex >= items.length) {
      showToast(delta > 0 ? '已经是最后一张了' : '已经是第一张了', { type: 'info' });
      return;
    }
    rememberCurrentState();
    navStateRef.current = { items, index: nextIndex };
    switchToImage(items[nextIndex], { top: 0, anchor: null }, delta);
  }, [rememberCurrentState, switchToImage]);

  const handleBack = () => {
    const cur = stackRef.current[stackRef.current.length - 1];
    rememberCurrentState();
    log.info('pop:', cur?.illustId, 'stack:', stackRef.current.length);
    stackRef.current.pop();
    const prev = stackRef.current[stackRef.current.length - 1];
    if (prev) {
      navStateRef.current = navStateMapRef.current[scrollKeyOf(prev)] || normalizeNavState(prev, navContext);
      setRestoreState(scrollMapRef.current[scrollKeyOf(prev)] || { top: 0, anchor: null });
      log.info('restore:', prev.illustId);
      setImage(prev);
    } else {
      log.info('close');
      onClose();
    }
  };
  handleBackRef.current = handleBack;

  // 系统返回手势/返回键：先弹详情内历史，栈空才关闭详情页
  useEffect(() => {
    return registerBackHandler(() => {
      handleBackRef.current();
      return true;
    });
  }, []);

  useEffect(() => () => clearTimeout(slideTimerRef.current), []);

  const handleTouchStart = useCallback((e) => {
    if (e.touches.length !== 1 || isInteractiveTarget(e.target)) {
      swipeRef.current = null;
      return;
    }
    const t = e.touches[0];
    swipeRef.current = {
      x: t.clientX,
      y: t.clientY,
      t: Date.now(),
      locked: null,
    };
  }, []);

  const handleTouchMove = useCallback((e) => {
    const swipe = swipeRef.current;
    if (!swipe || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - swipe.x;
    const dy = t.clientY - swipe.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (!swipe.locked && (ax > 18 || ay > 18)) {
      swipe.locked = ax > ay * 1.2 ? 'x' : 'y';
    }
    if (swipe.locked === 'x') e.preventDefault();
  }, []);

  const handleTouchEnd = useCallback((e) => {
    const swipe = swipeRef.current;
    swipeRef.current = null;
    if (!swipe || swipe.locked !== 'x') return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.x;
    const dy = t.clientY - swipe.y;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const elapsed = Math.max(1, Date.now() - swipe.t);
    const velocity = ax / elapsed;
    if (ax >= SWIPE_TRIGGER_PX && ax > ay * SWIPE_DIRECTION_RATIO && (velocity > 0.18 || ax > window.innerWidth * 0.22)) {
      handleSibling(dx < 0 ? 1 : -1);
    }
  }, [handleSibling]);

  return (
    <div
      className="detail-overlay"
      style={detailBgUrl ? { '--detail-bg-image': `url(${JSON.stringify(detailBgUrl)})` } : undefined}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div className="detail-glass-bg" aria-hidden="true" />
      {openTransition && (
        <div
          className={`shared-open-transition${openTransition.active ? ' is-active' : ''}`}
          style={{
            left: `${openTransition.active ? openTransition.to.left : openTransition.from.left}px`,
            top: `${openTransition.active ? openTransition.to.top : openTransition.from.top}px`,
            width: `${openTransition.active ? openTransition.to.width : openTransition.from.width}px`,
            height: `${openTransition.active ? openTransition.to.height : openTransition.from.height}px`,
          }}
          aria-hidden="true"
        >
          <img src={openTransition.src} alt="" draggable={false} />
        </div>
      )}
      <button className="glass-icon-btn detail-back-home" onClick={onExitToHome} aria-label="返回主页">
        <BackIcon />
      </button>
      <ImageDetailView
        key={image?.illustId ? `${image.illustId}:${image._pageIndex ?? 0}` : 'detail'}
        className={slideDirection < 0 ? 'detail-slide-from-left' : (slideDirection > 0 ? 'detail-slide-from-right' : '')}
        image={image}
        onBack={handleBack}
        onSelectImage={handleSelect}
        onSearchTag={onSearchTag}
        onAuthorWorks={onAuthorWorks}
        restoreScroll={restoreState.top}
        restoreAnchor={restoreState.anchor}
      />
    </div>
  );
}

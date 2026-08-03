import { useEffect, useRef, useState } from 'react';

/** 触发刷新的下拉距离阈值（px） */
const THRESHOLD = 64;
/** 下拉指示器最大位移（px），超出后按比例阻尼 */
const MAX_DISTANCE = 110;

/**
 * 下拉刷新 — 监听 .app-content 滚动容器，在 scrollTop=0 时向下拖动触发 onRefresh。
 * 只在页面内容区可见时生效；刷新中显示 spinner，完成后自动回弹。
 *
 * @param {Function} onRefresh — () => Promise，刷新完成后指示器收起
 */
export default function PullToRefresh({ onRefresh }) {
  const [state, setState] = useState('idle'); // idle | pulling | refreshing
  const [distance, setDistance] = useState(0);
  const distanceRef = useRef(0);
  const startYRef = useRef(null);
  const refreshingRef = useRef(false);
  const rafRef = useRef(null);

  /** 动画回弹到目标位移 */
  const animateTo = (target, onDone) => {
    cancelAnimationFrame(rafRef.current);
    const from = distanceRef.current;
    const t0 = performance.now();
    const dur = 200;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - (1 - p) * (1 - p);
      const value = from + (target - from) * eased;
      distanceRef.current = value;
      setDistance(value);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        onDone?.();
      }
    };
    rafRef.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    const el = document.querySelector('.app-content');
    if (!el) return;

    const onTouchStart = (e) => {
      if (refreshingRef.current) return;
      if (el.scrollTop > 0) return;
      if (e.touches.length !== 1) return;
      startYRef.current = e.touches[0].clientY;
    };

    const onTouchMove = (e) => {
      if (startYRef.current == null || refreshingRef.current) return;
      if (el.scrollTop > 0) return;
      const delta = e.touches[0].clientY - startYRef.current;
      // 带阻尼的下拉位移，避免过度拉伸
      const d = Math.max(0, Math.min(MAX_DISTANCE, delta * 0.5));
      if (Math.abs(d - distanceRef.current) < 1) return;
      distanceRef.current = d;
      setDistance(d);
      setState('pulling');
    };

    const onTouchEnd = () => {
      if (startYRef.current == null) return;
      startYRef.current = null;
      if (refreshingRef.current) return;
      const d = distanceRef.current;
      if (d >= THRESHOLD) {
        setState('refreshing');
        refreshingRef.current = true;
        Promise.resolve(onRefresh?.()).catch(() => {}).finally(() => {
          refreshingRef.current = false;
          animateTo(0, () => setState('idle'));
        });
      } else {
        animateTo(0, () => setState('idle'));
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      cancelAnimationFrame(rafRef.current);
    };
  }, [onRefresh]);

  if (state === 'idle') return null;
  const label = state === 'refreshing' ? '刷新中...' : (distance >= THRESHOLD ? '松开刷新' : '下拉刷新');
  return (
    <div
      className="ptr-indicator"
      style={{ transform: `translateX(-50%) translateY(${distance}px)` }}
    >
      {state === 'refreshing'
        ? <span className="ptr-spinner" />
        : <span className="ptr-arrow">↓</span>}
      <span>{label}</span>
    </div>
  );
}

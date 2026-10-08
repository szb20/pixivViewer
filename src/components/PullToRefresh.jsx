import { useEffect, useRef, useState } from 'react';
import { getMainScrollEl } from '../utils/scroll.js';

/** 触发刷新的下拉距离阈值（px） */
const THRESHOLD = 64;
/** 下拉指示器最大位移（px），超出后按比例阻尼 */
const MAX_DISTANCE = 70;

/**
 * 下拉刷新 — 监听 .app-content 滚动容器，在 scrollTop=0 时向下拖动触发 onRefresh。
 * 指示器是一枚进度环（无文字）：下拉时弧长跟着手指长，满圈即松手刷新，刷新时转起来。
 * 环画在玻璃圆盘里（.ptr-indicator），压在作品图上也能看清。
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

  /** 动画回弹到目标位置 */
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
    const el = getMainScrollEl();
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
      const d = Math.max(0, Math.min(MAX_DISTANCE, delta * 0.6));
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

    // 手势被打断：直接复位，不触发刷新
    const onTouchCancel = () => {
      startYRef.current = null;
      if (refreshingRef.current) return;
      animateTo(0, () => setState('idle'));
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    // touchcancel（来电/通知栏下拉/手势导航打断）不会触发 touchend：
    // 不复位会让指示器永久挂在屏幕上，直到下一次下拉
    el.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
      cancelAnimationFrame(rafRef.current);
    };
  }, [onRefresh]);

  if (state === 'idle') return null;

  const refreshing = state === 'refreshing';
  const progress = Math.min(1, distance / THRESHOLD);
  // 弧长：下拉时 = 进度（满圈就是「松手即刷新」的信号），刷新时留一小段固定弧让 CSS 带着转
  const R = 9;
  const CIRC = 2 * Math.PI * R;
  const arcLen = CIRC * Math.max(refreshing ? 0.28 : progress, 0.001);

  return (
    <div
      className={`ptr-indicator ${refreshing ? 'ptr-refreshing' : ''}`}
      style={{ transform: `translateX(-50%) translateY(${distance}px)` }}
    >
      {/* 环从 12 点方向起画：rotate 写成 SVG 属性而不是 CSS transform ——
          降低动效的媒体查询里对 .ptr-refreshing .ptr-ring 有 transform: none !important，
          用 CSS 的话那一档会把起点转回 3 点方向 */}
      <svg className="ptr-ring" width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="ptr-ring-track" cx="12" cy="12" r={R} transform="rotate(-90 12 12)" />
        <circle
          className="ptr-ring-arc"
          cx="12" cy="12" r={R}
          transform="rotate(-90 12 12)"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC - arcLen}
        />
      </svg>
    </div>
  );
}

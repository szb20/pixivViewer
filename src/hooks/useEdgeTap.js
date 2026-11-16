/**
 * useEdgeTap — 屏幕左右边缘轻点呼出导航抽屉（手机端）。
 *
 * 为什么不用「左边缘右滑」：全面屏手势导航下系统会抢占左右两侧边缘的
 * 滑动手势做「返回」，WebView 内收不到那块起手。轻点不属于系统手势，
 * 左右缘都可以全域生效；想滑动返回或滚列表时手指一挪即不算轻点。
 *
 * 判定：起手点落在左或右边缘 40px 内，250ms 内抬起且位移不超过 12px。
 * touchend 用非 passive 监听：命中时 preventDefault() 吞掉这次触摸合成
 * 的 click，否则底下的网格卡片会同时打开详情。起手在按钮 / 链接等可点
 * 元素上时不拦截 —— 详情页返回钮等边缘控件保持原有点击行为。
 *
 * @param {boolean} enabled  手势是否可用（手机端 && 抽屉未开 && 无全屏覆盖层）
 * @param {function} onTrigger 轻点确认后的回调（打开抽屉），需为稳定引用
 */
import { useEffect } from 'react';

/** 边缘手势区的判定宽度（px），两指宽 ≈ 拇指侧沿的自然落点 */
export const EDGE_ZONE = 40;

/** 这些元素上的起手不拦截，保持自身的点击行为（返回钮 / 链接 / 输入框…） */
const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], [contenteditable="true"]';

export function useEdgeTap(enabled, onTrigger) {
  useEffect(() => {
    if (!enabled) return;

    const TAP_MS = 250; // 轻点最长按住时长（ms），按久了不算（可能是长按菜单）
    const MOVE_TOLERANCE = 12; // 允许的最大位移（px），挪动即视为滑动放弃

    let startX = 0;
    let startY = 0;
    let startT = 0;
    let tracking = false;

    const inEdge = (x) => {
      const innerW = window.innerWidth || document.documentElement.clientWidth;
      return x < EDGE_ZONE || x >= innerW - EDGE_ZONE;
    };

    const onTouchStart = (e) => {
      const t = e.touches[0];
      if (!t) return;
      if (!inEdge(t.clientX)) return;
      if (e.target.closest?.(INTERACTIVE)) return;
      tracking = true;
      startX = t.clientX;
      startY = t.clientY;
      startT = Date.now();
    };

    const onTouchMove = (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      if (!t) return;
      // 按住期间挪动手指（滑成系统返回、或竖向滚列表）即视为放弃轻点
      if (
        Math.abs(t.clientX - startX) > MOVE_TOLERANCE ||
        Math.abs(t.clientY - startY) > MOVE_TOLERANCE
      ) {
        tracking = false;
      }
    };

    const onTouchEnd = (e) => {
      if (!tracking) return;
      tracking = false;
      if (Date.now() - startT > TAP_MS) return;
      const t = e.changedTouches[0];
      const endX = t ? t.clientX : startX;
      const endY = t ? t.clientY : startY;
      if (
        Math.abs(endX - startX) > MOVE_TOLERANCE ||
        Math.abs(endY - startY) > MOVE_TOLERANCE ||
        !inEdge(endX)
      ) return;
      // 吞掉本次触摸合成的 click：底下的网格卡片/手势不再响应这次轻点
      e.preventDefault();
      onTrigger();
    };

    const onTouchCancel = () => { tracking = false; };

    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
    document.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
    document.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart, { capture: true });
      document.removeEventListener('touchmove', onTouchMove, { capture: true });
      document.removeEventListener('touchend', onTouchEnd, { capture: true });
      document.removeEventListener('touchcancel', onTouchCancel, { capture: true });
    };
  }, [enabled, onTrigger]);
}

/**
 * useEdgeLongPress — 屏幕右边缘长按呼出导航抽屉（手机端）。
 *
 * 为什么不用「左边缘右滑」：全面屏手势导航下系统会抢占左右两侧边缘的
 * 滑动手势做「返回」，WebView 内收不到那块起手；系统手势豁免区每边
 * 竖向又只有 200dp，导致中段能拉抽屉、上下段却退出，行为割裂很怪。
 * 长按不属于系统手势，右缘长按可以全域生效，且想滑动返回时手指一挪
 * 长按即取消，互不干扰。
 *
 * 判定：起手点落在右边缘 24px 内，按住 360ms 且位移不超过 12px 即触发。
 * 360ms 略快于系统 400ms 的长按阈值，抢先于 WebView 的图片长按菜单。
 *
 * @param {boolean} enabled  手势是否可用（手机端 && 抽屉未开 && 无全屏覆盖层）
 * @param {function} onTrigger 长按确认后的回调（打开抽屉），需为稳定引用
 */
import { useEffect } from 'react';

export function useEdgeLongPress(enabled, onTrigger) {
  useEffect(() => {
    if (!enabled) return;

    const EDGE_ZONE = 24; // 起手点距右边缘的判定宽度（px）
    const HOLD_MS = 360; // 长按确认时长（ms）
    const MOVE_TOLERANCE = 12; // 按住期间允许的最大位移（px）

    let timer = null;
    let startX = 0;
    let startY = 0;
    let fired = false;

    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onTouchStart = (e) => {
      const t = e.touches[0];
      if (!t) return;
      const innerW = window.innerWidth || document.documentElement.clientWidth;
      if (t.clientX < innerW - EDGE_ZONE) return;
      startX = t.clientX;
      startY = t.clientY;
      fired = false;
      clear();
      timer = setTimeout(() => {
        timer = null;
        if (!fired) {
          fired = true;
          onTrigger();
        }
      }, HOLD_MS);
    };

    const onTouchMove = (e) => {
      if (!timer) return;
      const t = e.touches[0];
      if (!t) return;
      // 按住期间挪动手指（右滑成系统返回、或竖向滚列表）即视为放弃长按
      if (
        Math.abs(t.clientX - startX) > MOVE_TOLERANCE ||
        Math.abs(t.clientY - startY) > MOVE_TOLERANCE
      ) {
        clear();
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
    document.addEventListener('touchend', clear, { passive: true });
    document.addEventListener('touchcancel', clear, { passive: true });

    return () => {
      clear();
      document.removeEventListener('touchstart', onTouchStart, { capture: true });
      document.removeEventListener('touchmove', onTouchMove, { capture: true });
      document.removeEventListener('touchend', clear);
      document.removeEventListener('touchcancel', clear);
    };
  }, [enabled, onTrigger]);
}

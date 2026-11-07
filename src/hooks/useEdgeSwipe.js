/**
 * useEdgeSwipe — 左边缘右滑手势（手机端从屏幕左边缘拉出导航抽屉）。
 *
 * 判定：起手点落在左边缘 24px 内，且右滑 ≥32px、横向位移明显大于纵向
 * （竖向占优则视为列表滚动，放弃本次）。确认后触发 onSwipe，展开动画沿用
 * 抽屉自身的进场动画（不做跟手拖拽 —— 「滑一次就展开」的轻交互）。
 *
 * 与系统手势的关系：全面屏手势导航下，系统保留了最外侧一条窄边用于返回，
 * 从最边缘起滑会先触发系统返回；从稍靠内（约 >10dp）的位置起滑则本手势生效。
 * WebView 内无法抢占系统边缘手势，这是平台限制。
 *
 * @param {boolean} enabled  手绪是否可用（手机端 && 抽屉未开 && 无全屏覆盖层）
 * @param {function} onSwipe 右滑确认后的回调（打开抽屉），需为稳定引用
 */
import { useEffect } from 'react';

export function useEdgeSwipe(enabled, onSwipe) {
  useEffect(() => {
    if (!enabled) return;

    const EDGE_ZONE = 24; // 起手点距左边缘的判定宽度（px）
    const TRIGGER_DX = 32; // 确认展开所需的最小右滑距离（px）

    let startX = 0;
    let startY = 0;
    let active = false;

    const onTouchStart = (e) => {
      const t = e.touches[0];
      if (!t || t.clientX > EDGE_ZONE) return;
      active = true;
      startX = t.clientX;
      startY = t.clientY;
    };

    const onTouchMove = (e) => {
      if (!active) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (dx >= TRIGGER_DX && Math.abs(dx) > Math.abs(dy) * 1.2) {
        active = false;
        onSwipe();
      } else if (Math.abs(dy) > 32 && Math.abs(dy) > Math.abs(dx)) {
        // 已判定为竖向滚动，放弃本次起手
        active = false;
      }
    };

    const onTouchEnd = () => {
      active = false;
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart, { capture: true });
      document.removeEventListener('touchmove', onTouchMove, { capture: true });
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [enabled, onSwipe]);
}

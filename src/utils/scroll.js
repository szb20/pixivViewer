/**
 * scroll utils — centralize access to the app's main/detail scroll containers.
 *
 * Keeping these selectors in one place reduces coupling between navigation,
 * pull-to-refresh, filter bars and detail-page history restoration.
 */

export function getMainScrollEl() {
  return document.querySelector('.app-content');
}

export function getDetailScrollEl() {
  return document.querySelector('.char-state-content');
}

export function getScrollTop(el) {
  return el?.scrollTop || 0;
}

export function setScrollTop(el, scrollTop = 0) {
  if (el) el.scrollTop = scrollTop || 0;
}

/**
 * 恢复主列表滚动位置。
 *
 * 关闭详情页回列表时，列表可能因懒加载重挂载/布局重排导致高度暂时塌陷，
 * scrollTop 被钳制或复位到 0（表现为"回退后回到顶部"）。
 * 因此先同步设置一次，再在接下来约 300ms 内持续校准；
 * 一旦检测到用户主动滚动（touch/wheel）立即停止，避免抢夺滚动权。
 */
export function restoreMainScroll(scrollTop = 0) {
  const el = getMainScrollEl();
  if (!el) return;
  setScrollTop(el, scrollTop);

  const ac = new AbortController();
  const stop = () => ac.abort();
  el.addEventListener('touchstart', stop, { passive: true, signal: ac.signal });
  el.addEventListener('wheel', stop, { passive: true, signal: ac.signal });

  let frames = 0;
  const reassert = () => {
    if (ac.signal.aborted) return;
    if (Math.abs(getScrollTop(el) - scrollTop) > 2) setScrollTop(el, scrollTop);
    if (++frames < 20) requestAnimationFrame(reassert); // ~330ms @60fps
    else stop();
  };
  requestAnimationFrame(reassert);
}

/**
 * 冷启动恢复主列表滚动位置（页面快照）。
 *
 * 与 restoreMainScroll 的区别：冷启动时列表数据走 IndexedDB 水合 + 渲染，
 * 内容高度不是立即就绪的，直接设置 scrollTop 会被钳制到 0。
 * 这里轮询等待可滚动高度就绪后再恢复；超时则放弃（当没有快照处理）。
 */
export function restoreMainScrollOnColdStart(scrollTop = 0, timeoutMs = 5000) {
  if (!scrollTop) return;
  const start = Date.now();
  const tryRestore = () => {
    const el = getMainScrollEl();
    // 内容（含懒加载占位）已渲染出足够高度，或已超时 → 恢复（浏览器会自动钳制越界值）
    if (!el || el.scrollHeight - el.clientHeight >= scrollTop - 2 || Date.now() - start > timeoutMs) {
      restoreMainScroll(scrollTop);
      return;
    }
    setTimeout(tryRestore, 120);
  };
  tryRestore();
}
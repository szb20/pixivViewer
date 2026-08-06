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

export function restoreMainScroll(scrollTop = 0) {
  requestAnimationFrame(() => {
    setScrollTop(getMainScrollEl(), scrollTop);
  });
}

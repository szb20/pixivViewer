/**
 * useIsDesktop — 当前是否处于桌面布局（≥900px），窗口跨断点时重渲染。
 *
 * 900 与 CSS 的 @media (min-width: 900px)、ImageDetailView 的 useLargePreview 是同一个断点，
 * 改要三处一起改（CLAUDE.md：断点是硬编码的，改前全库搜）。
 *
 * 用 useSyncExternalStore 订阅 matchMedia，而不是渲染时算一次：
 * 桌面端的搜索悬浮框要靠它跨断点时自动收起 / 换成手机形态。
 */
import { useSyncExternalStore } from 'react';

const QUERY = '(min-width: 900px)';

function subscribe(onChange) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

const getSnapshot = () => window.matchMedia(QUERY).matches;

// 非浏览器环境（无 matchMedia）按手机形态处理
const getServerSnapshot = () => false;

export function useIsDesktop() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

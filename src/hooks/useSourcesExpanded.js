/**
 * 侧边栏「来源」组的展开/收起状态。
 *
 * 展开态持久化到 localStorage：收起偏好重启后保持，展开则是首次打开的合理默认。
 * 用 useSyncExternalStore 让桌面 SideNav 与手机 SourceDrawer 共享同一份状态。
 */
import { useSyncExternalStore } from 'react';

const KEY = 'pv:sourcesExpanded';

let expanded = true;
try { expanded = localStorage.getItem(KEY) !== '0'; } catch { /* 存储不可用时默认展开 */ }

const listeners = new Set();
const emit = () => listeners.forEach(fn => fn());

export function getSourcesExpanded() { return expanded; }

export function setSourcesExpanded(v) {
  const next = !!v;
  if (next === expanded) return;
  expanded = next;
  try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* 忽略 */ }
  emit();
}

export function useSourcesExpanded() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getSourcesExpanded,
  );
}

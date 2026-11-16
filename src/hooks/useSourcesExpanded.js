/**
 * 侧边栏「来源」组的展开/收起状态。
 *
 * 展开态持久化到 appStorage（统一小数据入口）：收起偏好重启后保持，展开是默认。
 * 用 useSyncExternalStore 让桌面侧边栏与手机抽屉里的同一份导航（SideNav）共享状态。
 */
import { useSyncExternalStore } from 'react';
import { appStorage, migrateFromLegacyKey } from '../utils/appStorage.js';

// 旧独立 key（'0'/'1' 字符串）一次性迁移到统一存储
migrateFromLegacyKey('pv:sourcesExpanded', 'sourcesExpanded');
// 未存过 = undefined !== 0 → 默认展开；旧数据迁移后是 0/1 数字，语义不变
let expanded = true;
try { expanded = appStorage.get('sourcesExpanded') !== 0; } catch { /* 存储不可用时默认展开 */ }

const listeners = new Set();
const emit = () => listeners.forEach(fn => fn());

export function getSourcesExpanded() { return expanded; }

export function setSourcesExpanded(v) {
  const next = !!v;
  if (next === expanded) return;
  expanded = next;
  try { appStorage.set('sourcesExpanded', next ? 1 : 0); } catch { /* 忽略 */ }
  emit();
}

export function useSourcesExpanded() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getSourcesExpanded,
  );
}

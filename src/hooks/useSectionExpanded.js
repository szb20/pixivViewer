/**
 * 侧边栏二级项（「排行」的档位 / 「我」的子页签）的展开-收起状态。
 *
 * 与「来源」组同款交互：标题行右侧的箭头单独可点，手动展开/收起，选择持久化到 localStorage。
 * 值是三态：
 *   - 没选过（键不存在）→ 跟随「当前是不是这个章节」的旧规则（免得「我」4 项 +「排行」8 项
 *     一上来就常驻铺开，把侧边栏撑得很长）；
 *   - 用户手动点过 → 以他的选择为准，切页签也不翻。
 * 用 useSyncExternalStore 让桌面侧边栏与手机抽屉里的同一份导航（SideNav）共享状态。
 */
import { useSyncExternalStore } from 'react';

const KEY = 'pv:navExpanded';
/** 形态为「导航行 + 二级项」的章节 */
const SECTIONS = ['ranking', 'me'];

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    const out = {};
    for (const k of SECTIONS) if (typeof raw?.[k] === 'boolean') out[k] = raw[k];
    return out;
  } catch {
    return {};
  }
}

let expanded = load();

const listeners = new Set();
const emit = () => listeners.forEach(fn => fn());

export function getSectionExpanded() { return expanded; }

export function setSectionExpanded(section, v) {
  const next = !!v;
  if (expanded[section] === next) return;
  expanded = { ...expanded, [section]: next };
  try { localStorage.setItem(KEY, JSON.stringify(expanded)); } catch { /* 存储不可用就算了 */ }
  emit();
}

/** 返回 { [section]: boolean } —— 只有用户手动改过的键才在对象里 */
export function useSectionExpanded() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getSectionExpanded,
  );
}

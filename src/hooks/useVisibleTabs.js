/**
 * useVisibleTabs — 主导航 tab 的显示控制。
 *
 * 两层过滤合一（原先只有第一层，写在 App.jsx）：
 *   1. 来源能力位：booru 没有 ranking/search 的接口，caps 过滤掉；
 *      关注/订阅/喜欢/收藏（原「我」页拆开的四项）按 getMeSubTabs 裁剪；
 *   2. 用户开关：设置页「显示的页面」，三个网络 grid 页（推荐/排行/搜索）可关。
 *
 * 「喜欢」等拆开的页签不提供开关：本地数据页关掉后应用就没有任何常驻页了。
 * 全部关掉也不怕 —— 侧边栏仍会保留它们，切换器不会空。
 *
 * 搜索页被关后若被使用（点标签 / 搜索框提交 / 作者页跳转都会 setActiveTab('search')），
 * App 的兜底 effect 会自动把它拉回来（setTabVisible），而不是跳回首页。
 */
import { useSyncExternalStore } from 'react';
import { getSettings, getSettingsSync, saveSettings } from '../pixiv-assistant/index.js';
import { getSource } from '../sources/registry.js';
import { ME_SUB_TABS, getMeSubTabs } from '../utils/meTabs.js';

const TABS = [
  { key: 'discover', label: '推荐' },
  { key: 'ranking', label: '排行' },
  ...ME_SUB_TABS, // 关注 / 订阅 / 喜欢 / 收藏 —— 按来源裁剪（getMeSubTabs）
  { key: 'search', label: '搜索' },
];

/** 「我」拆开的页签 key 集合：这些走 getMeSubTabs 过滤而非 caps */
const ME_TAB_KEYS = new Set(ME_SUB_TABS.map(t => t.key));

/** 主 tab ↔ 来源能力位 */
const TAB_CAP_KEYS = { discover: 'feed', ranking: 'ranking', search: 'search' };

/** 设置页可开关的 tab（「那三个 grid」）；拆开的本地/账号态页签恒显示 */
const TOGGLEABLE = new Set(['discover', 'ranking', 'search']);

// 同步取初值：settings 在 localStorage，首帧就拿到，避免先全显再闪隐。
// 数组缺省 = 全部显示，老用户零迁移。
const initial = getSettingsSync();
let hiddenTabs = new Set(
  Array.isArray(initial.hiddenTabs) ? initial.hiddenTabs.filter(k => TOGGLEABLE.has(k)) : []
);
let bootstrapped = false;

const listeners = new Set();

function emit() {
  for (const fn of [...listeners]) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  if (!bootstrapped) {
    bootstrapped = true;
    // 异步兜底：settings 可能被注入过自定义实现，与同步读不一致
    getSettings().then((s) => {
      const hidden = Array.isArray(s.hiddenTabs) ? s.hiddenTabs.filter(k => TOGGLEABLE.has(k)) : [];
      if (hidden.length !== hiddenTabs.size || hidden.some(k => !hiddenTabs.has(k))) {
        hiddenTabs = new Set(hidden);
        version += 1;
        hiddenSnapshot = [...hiddenTabs];
        emit();
      }
    }).catch(() => { });
  }
  return () => listeners.delete(fn);
}

function computeTabs(sourceId) {
  const { caps } = getSource(sourceId);
  const meKeys = new Set(getMeSubTabs(sourceId).map(t => t.key));
  return TABS.filter((t) => {
    if (TOGGLEABLE.has(t.key) && hiddenTabs.has(t.key)) return false;
    // 「我」拆开的四项：按 getMeSubTabs 的结果裁剪（X 只有关注/喜欢，booru 只剩喜欢）
    if (ME_TAB_KEYS.has(t.key)) return meKeys.has(t.key);
    const cap = TAB_CAP_KEYS[t.key];
    return !cap || caps[cap] !== false;
  });
}

// useSyncExternalStore 要求 getSnapshot 引用稳定：按 (version, sourceId) 缓存，
// hiddenTabs 变化时 version 递增、旧快照整批作废
let version = 0;
const snapshotCache = new Map();

function getTabsSnapshot(sourceId) {
  const key = `${version}:${sourceId}`;
  if (!snapshotCache.has(key)) {
    snapshotCache.clear(); // 只留当前版本，避免切来源攒垃圾
    snapshotCache.set(key, computeTabs(sourceId));
  }
  return snapshotCache.get(key);
}

let hiddenSnapshot = [...hiddenTabs];

/** 当前来源下实际显示的主 tab 列表（响应式） */
export function useVisibleTabs(sourceId) {
  return useSyncExternalStore(subscribe, () => getTabsSnapshot(sourceId));
}

/** 被隐藏的 tab key 列表（响应式；设置页 chips 用） */
export function useHiddenTabKeys() {
  return useSyncExternalStore(subscribe, () => hiddenSnapshot);
}

/** 可开关的 tab 元数据（设置页渲染用） */
export function getToggleableTabs() {
  return TABS.filter(t => TOGGLEABLE.has(t.key));
}

/**
 * 显示/隐藏某个主 tab。非可开关项（me / 未知 key）静默忽略 ——
 * App 的搜索兜底会无脑调 setTabVisible('search', true)，无需调用方判断。
 * @param {string} key
 * @param {boolean} visible — true 显示 / false 隐藏
 */
export async function setTabVisible(key, visible) {
  if (!TOGGLEABLE.has(key)) return;
  if (hiddenTabs[visible ? 'delete' : 'add'](key) === false) return; // Set.add/delete：无变化返回 false
  version += 1;
  hiddenSnapshot = [...hiddenTabs];
  emit();
  try {
    const s = await getSettings();
    await saveSettings({ ...s, hiddenTabs: [...hiddenTabs] });
  } catch { /* 持久化失败不回滚：本次会话仍按用户选择工作 */ }
}

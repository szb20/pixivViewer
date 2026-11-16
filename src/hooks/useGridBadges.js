/**
 * useGridBadges — 网格卡片上四个信息标记（页数角标 / GIF ▶ / 红心 / ✕ 不再推荐）
 * 的显示开关。
 *
 * 设置页「卡片标记」chips 在这里。与来源开关（useImageSource）、页签开关
 * （useVisibleTabs）同一套模块单例模式：同步读初值 + useSyncExternalStore 广播 +
 * 自行持久化（不进 SettingsPage 的 doSave）。
 *
 * 生效机制与另两个不同：GridItem 是 memo 的高频组件，几百个实例各挂订阅
 * 不划算 —— 这里不驱动重渲染，而是把隐藏集写进 <html data-hide-badges="…">，
 * 由 grid.css 的属性选择器直接 display:none（attr~=word 匹配空格分隔词）。
 * 切换瞬时生效、零重渲染；模块加载即应用，无首帧闪烁。
 */
import { useSyncExternalStore } from 'react';
import { getSettings, getSettingsSync, saveSettings } from '../pixiv-assistant/index.js';

/** 可开关的标记 key ↔ 类名 */
const TOGGLEABLE = ['pages', 'gif', 'like', 'hide'];

const initial = getSettingsSync();
let hiddenBadges = new Set(
  Array.isArray(initial.hiddenGridBadges) ? initial.hiddenGridBadges.filter(k => TOGGLEABLE.includes(k)) : []
);
let hiddenSnapshot = [...hiddenBadges];
let bootstrapped = false;

const listeners = new Set();

function emit() {
  for (const fn of [...listeners]) fn();
}

/** 隐藏集 → <html data-hide-badges>（grid.css 的 [data-hide-badges~=…] 消费） */
function applyToDocument() {
  const el = document.documentElement;
  if (hiddenBadges.size) el.dataset.hideBadges = [...hiddenBadges].join(' ');
  else delete el.dataset.hideBadges;
}

// 模块加载即应用：getSettingsSync 读 localStorage 同步可得，首帧就是正确状态
applyToDocument();

function subscribe(fn) {
  listeners.add(fn);
  if (!bootstrapped) {
    bootstrapped = true;
    // 异步兜底：settings 可能被注入过自定义实现，与同步读不一致
    getSettings().then((s) => {
      const hidden = Array.isArray(s.hiddenGridBadges) ? s.hiddenGridBadges.filter(k => TOGGLEABLE.includes(k)) : [];
      if (hidden.length !== hiddenBadges.size || hidden.some(k => !hiddenBadges.has(k))) {
        hiddenBadges = new Set(hidden);
        hiddenSnapshot = [...hiddenBadges];
        applyToDocument();
        emit();
      }
    }).catch(() => { });
  }
  return () => listeners.delete(fn);
}

/** 被隐藏的标记 key 列表（响应式；设置页 chips 用） */
export function useHiddenGridBadges() {
  return useSyncExternalStore(subscribe, () => hiddenSnapshot);
}

/** 可开关的标记元数据（设置页渲染用） */
export function getToggleableGridBadges() {
  return [
    { key: 'pages', label: '页数' },
    { key: 'gif', label: 'GIF' },
    { key: 'like', label: '红心' },
    { key: 'hide', label: '✕' },
  ];
}

/**
 * 显示/隐藏某个卡片标记。未知 key 静默忽略。
 * @param {string} key — 'pages' | 'gif' | 'like'
 * @param {boolean} visible — true 显示 / false 隐藏
 */
export async function setGridBadgeVisible(key, visible) {
  if (!TOGGLEABLE.includes(key)) return;
  if (hiddenBadges[visible ? 'delete' : 'add'](key) === false) return; // Set.add/delete：无变化返回 false
  hiddenSnapshot = [...hiddenBadges];
  applyToDocument();
  emit();
  try {
    const s = await getSettings();
    await saveSettings({ ...s, hiddenGridBadges: [...hiddenBadges] });
  } catch { /* 持久化失败不回滚：本次会话仍按用户选择工作 */ }
}

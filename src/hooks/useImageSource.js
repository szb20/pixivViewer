/**
 * useImageSource — 全局图片来源状态（单选）。
 *
 * 所有 Tab 共用一个来源：点来源即切换，App.jsx 的 tab-pane key 含 sourceId，
 * 切换时列表 / 翻页游标 / 滚动位置 / 内存缓存全部重挂载重置。
 *
 * 状态放模块单例而非 props：详情页、保存流程等深层调用点也要读它，
 * 全部走 props 会把签名污染一大片。
 */
import { useSyncExternalStore } from 'react';
import { getSettings, getSettingsSync, saveSettings } from '../pixiv-assistant/index.js';
import { getSource, SOURCE_LIST } from '../sources/registry.js';

const SOURCE_ORDER = SOURCE_LIST.map(s => s.id);
const DEFAULT_SOURCE = 'pixiv';

// 同步取初值：settings 存在 localStorage，首帧就能拿到正确来源，
// 避免先按 pixiv 渲染再闪回用户选的站点。
const initial = getSettingsSync();
let currentSource = SOURCE_ORDER.includes(initial.imageSource) ? initial.imageSource : DEFAULT_SOURCE;
let safeOnly = initial.booruSafeOnly;
let bootstrapped = false;

const listeners = new Set();

function emit() {
  for (const fn of [...listeners]) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  if (!bootstrapped) {
    bootstrapped = true;
    // 异步兜底：settings 可能被注入过自定义实现（configurePixiv），与同步读不一致
    getSettings().then((s) => {
      const want = SOURCE_ORDER.includes(s.imageSource) ? s.imageSource : DEFAULT_SOURCE;
      if (want !== currentSource || s.booruSafeOnly !== safeOnly) {
        currentSource = want;
        safeOnly = s.booruSafeOnly === true;
        emit();
      }
    }).catch(() => { });
  }
  return () => listeners.delete(fn);
}

/** 当前来源 id（如 'pixiv' / 'yande'），可直接用于 cacheKey 前缀 */
export function getImageSourceId() {
  return currentSource;
}

/** 非 React 上下文读取：是否只显示 safe 内容 */
export function getBooruSafeOnly() {
  return safeOnly;
}

/** 切换来源：立即生效并广播，持久化在后台完成 */
export async function setImageSource(id) {
  if (!SOURCE_ORDER.includes(id) || id === currentSource) return;
  currentSource = id;
  emit();
  try {
    const s = await getSettings();
    await saveSettings({ ...s, imageSource: id });
  } catch { /* 持久化失败不回滚：本次会话仍按用户选择工作 */ }
}

/** 切换「非 Pixiv 来源只显示 safe」 */
export async function setBooruSafeOnly(value) {
  if (value === safeOnly) return;
  safeOnly = value;
  emit();
  try {
    const s = await getSettings();
    await saveSettings({ ...s, booruSafeOnly: value });
  } catch { /* 同上 */ }
}

/** 当前来源 id（响应式） */
export function useImageSourceId() {
  return useSyncExternalStore(subscribe, getImageSourceId);
}

/** 当前来源定义（label / caps / net） */
export function useImageSource() {
  return getSource(useImageSourceId());
}

/** 「非 Pixiv 来源只显示 safe」开关（响应式） */
export function useBooruSafeOnly() {
  return useSyncExternalStore(subscribe, getBooruSafeOnly);
}

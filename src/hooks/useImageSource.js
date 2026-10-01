/**
 * useImageSource — 全局图片来源状态。
 *
 * 一个开关影响全部 Tab（用户选定的方案）：App 用它做 tab-pane 的 key，
 * 切换时整块重挂载，列表 / 游标 / 滚动 / 内存缓存天然重置。
 *
 * 状态放模块单例而非 props：详情页、保存流程等深层调用点也要读它，
 * 全部走 props 会把签名污染一大片。
 */
import { useSyncExternalStore } from 'react';
import { getSettings, getSettingsSync, saveSettings } from '../pixiv-assistant/index.js';
import { getSource } from '../sources/registry.js';

// 同步取初值：settings 存在 localStorage，首帧就能拿到正确来源，
// 避免先按 pixiv 渲染再闪回用户选的站点。
const initial = getSettingsSync();
let currentSource = initial.imageSource;
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
      if (s.imageSource !== currentSource || s.booruSafeOnly !== safeOnly) {
        currentSource = s.imageSource;
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
  if (id === currentSource) return;
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

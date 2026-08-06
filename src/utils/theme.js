/**
 * 主题色系统 — 可持久化 + CSS 变量驱动，全站自动生效。
 */
import { appStorage } from './appStorage.js';

export const THEMES = [
  { key: 'white',    label: '亮白', color: '#ffffff', rgb: '255, 255, 255' },
  { key: 'blue',     label: '天蓝', color: '#4f8cff', rgb: '79, 140, 255' },
  { key: 'periwinkle', label: '蓝紫', color: '#7c8aff', rgb: '124, 138, 255' },
  { key: 'mint',     label: '薄荷', color: '#4ade80', rgb: '74, 222, 128' },
  { key: 'amber',    label: '琥珀', color: '#ffa502', rgb: '255, 165, 2' },
  { key: 'rose',     label: '玫红', color: '#ff6b6b', rgb: '255, 107, 107' },
  { key: 'violet',   label: '淡紫', color: '#e6a6fa', rgb: '230, 166, 250' },
  { key: 'teal',     label: '青绿', color: '#2dd4bf', rgb: '45, 212, 191' },
];

const DEFAULT_THEME = 'blue';

export function applyTheme(key) {
  const t = THEMES.find(t => t.key === key) || THEMES.find(t => t.key === DEFAULT_THEME);
  const root = document.documentElement;
  root.style.setProperty('--color-accent', t.color);
  root.style.setProperty('--color-accent-rgb', t.rgb);
}

export function getSavedTheme() {
  try {
    // 统一存储：settings 对象内 theme 字段（与 saveSettings 同源）
    const s = appStorage.get('settings', {}) || {};
    if (s?.theme && THEMES.some(t => t.key === s.theme)) return s.theme;
  } catch { /* ignore */ }
  try {
    // 兜底：迁移前残留的旧版独立 key
    const raw = localStorage.getItem('pixiv_viewer_settings');
    if (raw) {
      const s = JSON.parse(raw);
      if (s?.theme && THEMES.some(t => t.key === s.theme)) return s.theme;
    }
  } catch { /* ignore */ }
  return DEFAULT_THEME;
}

export function initTheme() {
  applyTheme(getSavedTheme());
}

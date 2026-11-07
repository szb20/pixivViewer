/**
 * theme — 外观主题（暗色 / 浅色 / 跟随系统）的应用与切换。
 *
 * 实现：把解析结果写到 <html data-theme>，颜色翻转全部由 tokens.css 的
 * `:root[data-theme='light']` 覆盖完成，JS 只负责「选哪套」。
 * 未写入 data-theme 时缺省暗色 —— 老用户与冷启动首帧观感不变。
 *
 * 设置项 theme 存在 settings 里（'auto' | 'light' | 'dark'，缺省 'dark'），
 * SettingsPage 选中即调 setTheme 立即生效，App 启动时 initTheme 读档。
 */
import { getSettings } from '../pixiv-assistant/index.js';

const MQ_DARK = '(prefers-color-scheme: light)';

/** 当前设置的模式（'auto' | 'light' | 'dark'），auto 需要它来响应系统切换 */
let currentMode = 'dark';

function resolve(mode) {
  if (mode !== 'auto') return mode;
  return window.matchMedia(MQ_DARK).matches ? 'light' : 'dark';
}

function applyToRoot(mode) {
  const theme = resolve(mode);
  document.documentElement.dataset.theme = theme;
}

/** 启动时读档并应用；跟随系统模式下监听系统主题变化实时联动 */
export async function initTheme() {
  try {
    const s = await getSettings();
    currentMode = s.theme || 'dark';
  } catch {
    currentMode = 'dark';
  }
  applyToRoot(currentMode);

  // 仅 auto 模式响应系统切换；监听器常驻（挂一次），模式读取走 ref
  window.matchMedia(MQ_DARK).addEventListener('change', () => {
    if (currentMode === 'auto') applyToRoot('auto');
  });
}

/** 设置页切换：立即应用到 DOM，模式记录留给调用方持久化 */
export function setTheme(mode) {
  currentMode = mode;
  applyToRoot(mode);
}

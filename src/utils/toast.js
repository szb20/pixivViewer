/**
 * 轻量 toast — 通过 CustomEvent 广播，宿主 UI 可订阅渲染。
 * 独立 app 暂不引入 UI 库，先保持零依赖。
 */
let seq = 0;

export function showToast(message, opts = {}) {
  const type = opts.type || 'info';
  console.log(`[toast:${type}]`, message);
  window.dispatchEvent(new CustomEvent('pixiv:toast', {
    detail: { id: ++seq, message: String(message ?? ''), type },
  }));
}

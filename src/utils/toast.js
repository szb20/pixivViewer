/**
 * 轻量 toast — 通过 CustomEvent 广播，宿主 UI 可订阅渲染。
 */
let seq = 0;

export function showToast(message) {
  window.dispatchEvent(new CustomEvent('pixiv:toast', {
    detail: { id: ++seq, message: String(message ?? '') },
  }));
}

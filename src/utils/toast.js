/**
 * 轻量 toast — 通过 CustomEvent 广播，宿主 UI 可订阅渲染。
 *
 * @param {string} message  显示文本
 * @param {object} [opts]
 * @param {'info'|'success'|'error'|'warning'} [opts.type='info']  语义类型，驱动 CSS data-type
 */
let seq = 0;

export function showToast(message, { type = 'info' } = {}) {
  window.dispatchEvent(new CustomEvent('pixiv:toast', {
    detail: { id: ++seq, message: String(message ?? ''), type },
  }));
}

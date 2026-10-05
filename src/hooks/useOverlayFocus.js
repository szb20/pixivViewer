/**
 * useOverlayFocus — 覆盖层的焦点管理与 Esc 关闭。
 *
 * 解决两个键盘/读屏用户的实际问题：
 * 1. 打开设置/详情后，Tab 仍然从页面底部开始走，焦点不在覆盖层里；
 * 2. 关闭后焦点丢回 body，读屏用户直接迷路。
 *
 * 用法：
 *   const ref = useOverlayFocus(open, onClose);
 *   <div className="xxx-overlay" ref={ref} tabIndex={-1}>…</div>
 *
 * onClose 传 null 表示**只做焦点管理、不接管 Esc**（详情页就是这种：
 * 它的 Esc 归灯箱管，这里再插一手会把灯箱一起关掉）。
 *
 * Esc 只作用于**最上层**的覆盖层：详情 → 灯箱 → 下载抽屉 可能同时开着，
 * 一次 Esc 全关掉是错的。用模块级栈记录开启顺序，只有栈顶的处理器响应。
 * 注意：灯箱的 Esc 在 hooks/useTouchGesture.js 里自己实现，没有走这个栈 ——
 * 所以灯箱开着时按 Esc，本栈的顶层仍会响应（表现为灯箱和它下面那层一起关）。
 * 要彻底解决需要把灯箱也接进来，属于下一轮的事。
 */
import { useEffect, useRef } from 'react';

/** 当前打开的覆盖层，按打开顺序入栈；Esc 只触发栈顶 */
const escStack = [];

export function useOverlayFocus(active, onClose) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return undefined;

    // 打开前焦点在哪 —— 关闭时要还回去
    const prev = document.activeElement;
    // preventScroll：别把底下的滚动容器带着跳
    ref.current?.focus?.({ preventScroll: true });

    // 没接管 Esc 的（onClose 为空）：只做焦点，不注册键盘监听
    if (typeof onCloseRef.current !== 'function') return () => restore(prev);

    const entry = { onClose: () => onCloseRef.current?.() };
    escStack.push(entry);

    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      // 输入法正在拼字（中文/日文）：这次 Esc 是「取消候选」，不该顺手把覆盖层关掉
      if (e.isComposing || e.keyCode === 229) return;
      if (escStack[escStack.length - 1] !== entry) return; // 不是最上层，让给上面
      e.stopPropagation();
      entry.onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      const i = escStack.indexOf(entry);
      if (i >= 0) escStack.splice(i, 1);
      restore(prev);
    };
  }, [active]);

  return ref;
}

/** 把焦点还给打开覆盖层之前那个元素（可能已被卸载，那就什么都不做） */
function restore(prev) {
  if (prev instanceof HTMLElement && document.contains(prev)) {
    prev.focus({ preventScroll: true });
  }
}

import { useEffect, useRef, useState } from 'react';

/**
 * 轻量 toast 宿主 — 订阅 pixiv:toast 事件渲染。
 *
 * 同文案去重：存活期内（TOAST_MS）重复触发的同 message+type 不堆叠，
 * 只重置存活计时 —— 喜欢/下载链路里同一结果可能被多处汇总提示
 * （如「已喜欢」与长按下载的 like 前缀），先在展示层收敛掉视觉重复。
 */
const TOAST_MS = 2500;

export default function ToastHost() {
  const [toasts, setToasts] = useState([]);
  const toastsRef = useRef([]);
  const timersRef = useRef(new Map());

  useEffect(() => {
    // Map 在整个生命周期内不换引用（只 set/clear），拷贝到局部变量供 cleanup 使用
    const timers = timersRef.current;
    const dismiss = (id) => {
      timers.delete(id);
      toastsRef.current = toastsRef.current.filter(x => x.id !== id);
      setToasts(toastsRef.current);
    };

    const onToast = (e) => {
      const message = String(e.detail?.message ?? '');
      const type = e.detail?.type || 'info';
      if (!message) return;
      // 同文案还在屏上：不堆叠第二条，只延长这条的存活期
      const existing = toastsRef.current.find(t => t.message === message && t.type === type);
      if (existing) {
        clearTimeout(timers.get(existing.id));
        timers.set(existing.id, setTimeout(() => dismiss(existing.id), TOAST_MS));
        return;
      }
      const t = { id: e.detail?.id || Date.now(), message, type };
      toastsRef.current = [...toastsRef.current, t];
      setToasts(toastsRef.current);
      timers.set(t.id, setTimeout(() => dismiss(t.id), TOAST_MS));
    };

    window.addEventListener('pixiv:toast', onToast);
    return () => {
      window.removeEventListener('pixiv:toast', onToast);
      for (const tid of timers.values()) clearTimeout(tid);
      timers.clear();
    };
  }, []);

  if (!toasts.length) return null;
  return (
    <div className="toast-host">
      {toasts.map(t => (
        <div key={t.id} className="toast" data-type={t.type || 'info'}>{t.message}</div>
      ))}
    </div>
  );
}

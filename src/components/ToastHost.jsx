import { useEffect, useState } from 'react';

export default function ToastHost() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const onToast = (e) => {
      const t = { id: e.detail?.id || Date.now(), message: e.detail?.message || '' };
      setToasts(prev => [...prev, t]);
      setTimeout(() => {
        setToasts(prev => prev.filter(x => x.id !== t.id));
      }, 2500);
    };
    window.addEventListener('pixiv:toast', onToast);
    return () => window.removeEventListener('pixiv:toast', onToast);
  }, []);

  if (!toasts.length) return null;
  return (
    <div className="toast-host">
      {toasts.map(t => <div key={t.id} className="toast frosted">{t.message}</div>)}
    </div>
  );
}

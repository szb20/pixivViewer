import { useEffect } from 'react';

/** 简易全屏预览（详情页组件搬进来前的过渡方案） */
export default function PreviewModal({ item, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!item) return null;
  return (
    <div className="preview" onClick={onClose}>
      <img
        className="preview-img"
        src={item.mediumUrl || item.thumbnailUrl}
        alt={item.title || ''}
        onClick={e => e.stopPropagation()}
      />
      <div className="preview-info" onClick={e => e.stopPropagation()}>
        <div className="preview-title">{item.title || '未命名'}</div>
        <div className="preview-author">@{item.authorName || item.author || ''}</div>
      </div>
      <button className="preview-close" onClick={onClose}>✕</button>
    </div>
  );
}

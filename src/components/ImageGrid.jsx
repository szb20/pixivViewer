/**
 * 双列图片网格 — 单条目（一个作品一格），支持已保存绿点与 GIF 角标。
 */
export default function ImageGrid({ items, savedSet, onOpen }) {
  if (!items?.length) return null;
  return (
    <div className="grid">
      {items.map(img => (
        <div key={img.illustId} className="grid-item" onClick={() => onOpen?.(img)}>
          <img
            className="grid-thumb"
            src={img.thumbnailUrl || img.mediumUrl}
            alt={img.title || ''}
            loading="lazy"
            onError={e => { e.target.style.display = 'none'; }}
          />
          {savedSet?.has(`${img.illustId}_0`) && <span className="grid-dot" />}
          {Number(img.illustType) === 2 && <span className="grid-gif">GIF</span>}
        </div>
      ))}
    </div>
  );
}

import { useState } from 'react';
import HeartIcon from './icons/HeartIcon.jsx';

function GridItem({ img, isLiked, onOpen }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="grid-item" onClick={() => onOpen?.(img)}>
      <img
        className="grid-thumb"
        src={img.thumbnailUrl || img.mediumUrl}
        alt={img.title || ''}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={e => { e.target.style.display = 'none'; }}
      />
      {loaded && isLiked && (
        <span className="grid-like">
          <HeartIcon filled />
        </span>
      )}
      {Number(img.illustType) === 2 && (
        <span className="grid-play">▶</span>
      )}
    </div>
  );
}

/**
 * 双列图片网格 — 单条目（一个作品一格）。
 */
export default function ImageGrid({ items, likedSet, onOpen }) {
  if (!items?.length) return null;
  return (
    <div className="grid">
      {items.map(img => (
        <GridItem
          key={img.illustId}
          img={img}
          isLiked={likedSet?.has(`${img.illustId}_0`)}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

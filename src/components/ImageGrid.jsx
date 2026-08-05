import { memo, useMemo, useState } from 'react';
import HeartIcon from './icons/HeartIcon.jsx';
import { buildLikedIllustIdSet } from '../utils/worksState.js';

const GridItem = memo(function GridItem({ img, isLiked, onOpen }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const handleClick = () => {
    onOpen?.(img);
  };

  if (error) return null;

  return (
    <div className="grid-item" onClick={handleClick}>
      <img
        className="grid-thumb"
        src={img.thumbnailUrl || img.mediumUrl}
        alt={img.title || ''}
        loading="lazy"
        decoding="async"
        style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s ease' }}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
      {isLiked && (
        <span className="grid-like">
          <HeartIcon filled />
        </span>
      )}
      {Number(img.pageCount) > 1 && (
        <span className="grid-pages frosted">
          {Number(img.pageCount)}
        </span>
      )}
      {Number(img.illustType) === 2 && (
        <span className="grid-play">▶</span>
      )}
    </div>
  );
}, (prev, next) => {
  return (
    prev.img.illustId === next.img.illustId &&
    prev.isLiked === next.isLiked &&
    prev.onOpen === next.onOpen
  );
});

const ImageGrid = memo(function ImageGrid({ items, likedSet, onOpen }) {
  // 同作品任意页点过喜欢都显示红心（不只看第 0 页）
  const likedIllustIds = useMemo(() => buildLikedIllustIdSet(likedSet), [likedSet]);
  if (!items?.length) return null;
  return (
    <div className="grid">
      {items.map(img => (
        <GridItem
          key={img.illustId}
          img={img}
          isLiked={likedIllustIds.has(img.illustId)}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
});

export default ImageGrid;

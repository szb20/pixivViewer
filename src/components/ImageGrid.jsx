import { memo, useState } from 'react';
import HeartIcon from './icons/HeartIcon.jsx';

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
}, (prev, next) => {
  return (
    prev.img.illustId === next.img.illustId &&
    prev.isLiked === next.isLiked &&
    prev.onOpen === next.onOpen
  );
});

const ImageGrid = memo(function ImageGrid({ items, likedSet, onOpen }) {
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
});

export default ImageGrid;

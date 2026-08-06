import { memo, useMemo } from 'react';
import GridItem from './GridItem.jsx';
import { buildLikedIllustIdSet } from '../utils/worksState.js';
import { hiddenWorks, useHiddenWorks } from '../utils/hiddenWorks.js';
import { useGridLikeToggle } from '../hooks/useGridLikeToggle.js';
import { showToast } from '../utils/toast.js';

const ImageGrid = memo(function ImageGrid({ items, likedSet, onOpen }) {
  const hiddenSet = useHiddenWorks();
  const toggleLike = useGridLikeToggle();
  // 同作品任意页点过喜欢都显示红心（不只看第 0 页）
  const likedIllustIds = useMemo(() => buildLikedIllustIdSet(likedSet), [likedSet]);

  // 过滤"不想看"的作品（✕ 加入后从所有网格实时消失）
  const visibleItems = useMemo(
    () => (hiddenSet.size ? items.filter(img => !hiddenSet.has(img.illustId)) : items),
    [items, hiddenSet],
  );

  if (!visibleItems?.length) return null;
  return (
    <div className="grid">
      {visibleItems.map(img => (
        <GridItem
          key={img.illustId}
          img={img}
          isLiked={likedIllustIds.has(img.illustId)}
          onOpen={onOpen}
          onLongPress={toggleLike}
          onHide={(id) => {
            hiddenWorks.add(id);
            showToast('已隐藏，不再推荐', { type: 'info' });
          }}
          variant="grid"
        />
      ))}
    </div>
  );
});

export default ImageGrid;

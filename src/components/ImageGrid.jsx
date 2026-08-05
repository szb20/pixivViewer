import { memo, useCallback, useMemo } from 'react';
import GridItem from './GridItem.jsx';
import { buildLikedIllustIdSet } from '../utils/worksState.js';
import { getCompositeKey } from '../pixiv-assistant/core/utils.js';
import { usePixivCache } from '../context/pixivCacheContext.js';
import { hiddenWorks, useHiddenWorks } from '../utils/hiddenWorks.js';
import { buildLikeMeta } from '../utils/likeMeta.js';
import { storageFacade } from '../pixiv-assistant/index.js';
import { showToast } from '../utils/toast.js';

const ImageGrid = memo(function ImageGrid({ items, likedSet, onOpen }) {
  const { pixivCache, setPixivCache } = usePixivCache();
  const hiddenSet = useHiddenWorks();
  // 同作品任意页点过喜欢都显示红心（不只看第 0 页）
  const likedIllustIds = useMemo(() => buildLikedIllustIdSet(likedSet), [likedSet]);

  // 长按 → 切换喜欢（仅 like，不下载）；乐观更新 + 失败回滚
  const toggleLike = useCallback(async (img) => {
    if (!img?.illustId) return;
    const ck = getCompositeKey({ illustId: img.illustId, _pageIndex: img._pageIndex ?? 0 });
    const prevLiked = pixivCache[ck]?.liked || false;
    setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: !prevLiked, likedAt: Date.now() } }));
    try {
      const result = await storageFacade.toggleLike(img.illustId, img._pageIndex ?? 0, buildLikeMeta(img));
      if (result.success) {
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: result.liked, likedAt: result.likedAt } }));
        showToast(result.liked ? '已喜欢' : '已取消喜欢');
      } else {
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      }
    } catch {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
    }
    window.dispatchEvent(new CustomEvent('pixiv:liked-changed'));
  }, [pixivCache, setPixivCache]);

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
            showToast('已隐藏，不再推荐');
          }}
          variant="grid"
        />
      ))}
    </div>
  );
});

export default ImageGrid;

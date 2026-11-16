import { memo, useCallback, useMemo, useRef } from 'react';
import GridItem from './GridItem.jsx';
import { MasonryFeed } from './MasonryFeed.jsx';
import { buildLikedIllustIdSet } from '../utils/worksState.js';
import { hiddenWorks, useHiddenWorks } from '../utils/hiddenWorks.js';
import { useGridActions } from '../hooks/useGridActions.js';
import { useGridLayout } from '../hooks/useGridLayout.js';
import { useProgressiveMount } from '../hooks/useProgressiveMount.js';
import { showToast } from '../utils/toast.js';

/**
 * ImageGrid — 网格包装：过滤「不想看」、组装喜欢集、把打开动作包装成
 * { items, index } 上下文，再按设置页的「网格样式」分发到方形宫格或瀑布流。
 * 瀑布流实现在 MasonryFeed.jsx（相关推荐也直接用它），宫格在本文件内联。
 *
 * @param {array}    items   作品条目
 * @param {Set}      likedSet 组合键likedSet（'illustId_page'），内部换算成 illustId 集
 * @param {function} onOpen  (img, { items, index }) => void
 * @param {string}   layout 'auto'（跟随设置）| 'grid' | 'masonry'
 */
const ImageGrid = memo(function ImageGrid({ items, likedSet, onOpen, layout = 'auto' }) {
  // layout='auto'（默认，绝大多数调用方）：跟随设置页「网格样式」开关（瀑布流/方形宫格）
  const gridLayout = useGridLayout();
  const resolvedLayout = layout === 'auto' ? gridLayout : layout;
  const hiddenSet = useHiddenWorks();
  const { toggleLike, downloadAll } = useGridActions();
  // 同作品任意页点过喜欢都显示红心（不只看第 0 页）
  const likedIllustIds = useMemo(() => buildLikedIllustIdSet(likedSet), [likedSet]);

  // 过滤"不想看"的作品（✕ 加入后从所有网格实时消失）
  const visibleItems = useMemo(
    () => (hiddenSet.size ? items.filter(img => !hiddenSet.has(img.illustId)) : items),
    [items, hiddenSet],
  );

  const handleHide = useCallback((id) => {
    hiddenWorks.add(id);
    showToast('已隐藏，不再推荐', { type: 'info' });
  }, []);

  // 宫格/瀑布流共用：包装成 { items, index } 供详情页左右切换（GridItem 传出的 index 是 items 下标）。
  // visibleItems 走 ref 稳定回调：触底 append 会让 visibleItems 换引用，
  // 若直接进依赖会打穿 GridItem 的 memo，已挂载的整批卡片全量重渲染。
  const visibleItemsRef = useRef(visibleItems);
  visibleItemsRef.current = visibleItems;
  const handleGridOpen = useCallback((img, index) => {
    onOpen?.(img, { items: visibleItemsRef.current, index });
  }, [onOpen]);

  // 宫格渐进挂载（见 useProgressiveMount 注释）。必须在所有条件 return 之前调用
  const { renderCap, sentinelRef } = useProgressiveMount(visibleItems?.length || 0);

  if (!visibleItems?.length) return null;

  if (resolvedLayout === 'masonry') {
    return (
      <MasonryFeed
        items={visibleItems}
        likedIllustIds={likedIllustIds}
        onOpen={handleGridOpen}
        onLongPress={downloadAll}
        onLike={toggleLike}
        onHide={handleHide}
      />
    );
  }

  return (
    <div className="grid">
      {visibleItems.slice(0, renderCap).map((img, index) => (
        <GridItem
          key={img.illustId}
          img={img}
          index={index}
          isLiked={likedIllustIds.has(img.illustId)}
          onOpen={handleGridOpen}
          onLongPress={downloadAll}
          onLike={toggleLike}
          onHide={handleHide}
          variant="grid"
        />
      ))}
      {visibleItems.length > renderCap && <div ref={sentinelRef} style={{ height: 1, gridColumn: '1 / -1' }} />}
    </div>
  );
});

export default ImageGrid;

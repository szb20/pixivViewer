import { useEffect, useRef } from 'react';
import { storageFacade } from '../pixiv-assistant/index.js';
import { useTabFeed } from '../hooks/useTabFeed.js';
import { pixivReUrl } from '../pixiv-assistant/core/utils.js';

const PAGE_SIZE = 24;
const CACHE_KEY = 'gallery';

export default function GalleryPage({ onOpen, registerRefresh }) {
  const offsetRef = useRef(0);

  // 本地数据源（IndexedDB 喜欢列表），分页 + 哨兵 + 刷新统一由 useTabFeed 处理
  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
    registerRefresh,
    fetchPage: async (append) => {
      if (!append) offsetRef.current = 0;
      const r = await storageFacade.listLiked(offsetRef.current, PAGE_SIZE);
      const list = r?.items || [];
      offsetRef.current += list.length;
      const hasMore = (r?.total || 0) > offsetRef.current;
      // 网格直接显示 250px 缩略图，不加载本地原图（避免大图刷屏）
      return { list, hasMore };
    },
  });
  const { load: reload } = feed;

  // 喜欢状态变化（详情页点❤️/取消）→ 刷新列表
  useEffect(() => {
    const onLikedChanged = () => reload(false);
    window.addEventListener('pixiv:liked-changed', onLikedChanged);
    return () => window.removeEventListener('pixiv:liked-changed', onLikedChanged);
  }, [reload]);

  return (
    <div className="page">
      {feed.loading && feed.items.length === 0 && <div className="hint">加载中...</div>}
      {!feed.loading && feed.error && (
        <div className="error-box">
          {feed.error}
          <button className="error-retry" onClick={() => feed.load(false)}>重试</button>
        </div>
      )}
      {!feed.loading && !feed.error && feed.items.length === 0 && (
        <div className="error-box">还没有喜欢的作品 — 在详情页点击爱心即可收藏</div>
      )}
      <div className="gallery-grid">
        {feed.items.map(item => {
          const id = `${item.illustId}_${item.pageIndex ?? 0}`;
          const src = pixivReUrl(String(item.illustId), item.pageIndex ?? 0, 'thumb');
          return (
            <div key={id} className="gallery-item"
              onClick={() => onOpen?.({
                illustId: item.illustId,
                _pageIndex: item.pageIndex ?? 0,
                _totalPages: item.frameCount || 1,
                type: item.isGif ? 'gif' : 'image',
                title: item.title,
                author: item.author,
                authorId: item.authorId,
                authorName: item.authorName,
                thumbnailUrl: pixivReUrl(String(item.illustId), 0, 'thumb'),
              })}
            >
              <img className="gallery-thumb" src={src} alt={item.title || ''} loading="lazy"
                onError={e => { e.target.style.display = 'none'; }} />
            </div>
          );
        })}
      </div>
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
    </div>
  );
}

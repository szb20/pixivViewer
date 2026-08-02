import { useCallback, useEffect, useRef, useState } from 'react';
import { storageFacade } from '../pixiv-assistant/index.js';
import { pixivReUrl } from '../pixiv-assistant/core/utils.js';

const PAGE_SIZE = 24;

export default function GalleryPage({ onOpen }) {
  const [items, setItems] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const sentinelRef = useRef(null);
  const thumbsRef = useRef({});

  const load = useCallback(async (append) => {
    setLoading(true);
    try {
      const r = await storageFacade.listLiked(offsetRef.current, PAGE_SIZE);
      const list = r?.items || [];
      offsetRef.current += list.length;
      setHasMore((r?.total || 0) > offsetRef.current);
      setItems(prev => (append ? [...prev, ...list] : list));
      for (const item of list) {
        const id = `${item.illustId}_${item.pageIndex ?? 0}`;
        if (thumbsRef.current[id]) continue;
        const local = await storageFacade.load(item.illustId, item.pageIndex ?? 0);
        if (local?.localUrl) {
          thumbsRef.current[id] = local.localUrl;
          setThumbs(prev => ({ ...prev, [id]: local.localUrl }));
        }
      }
    } catch { /* 忽略 */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(false); }, [load]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore) load(true);
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, load]);

  return (
    <div className="page">
      {loading && items.length === 0 && <div className="hint">加载中...</div>}
      {!loading && items.length === 0 && (
        <div className="error-box">还没有喜欢的作品 — 在详情页点击爱心即可收藏</div>
      )}
      <div className="gallery-grid">
        {items.map(item => {
          const id = `${item.illustId}_${item.pageIndex ?? 0}`;
          const src = thumbs[id] || pixivReUrl(String(item.illustId), item.pageIndex ?? 0);
          return (
            <div key={id} className="gallery-item"
              onClick={() => onOpen?.({
                illustId: item.illustId,
                _pageIndex: item.pageIndex ?? 0,
                _totalPages: item.frameCount || 1,
                type: item.isGif ? 'gif' : 'image',
                title: item.title,
                author: item.author,
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
      {!loading && hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
    </div>
  );
}

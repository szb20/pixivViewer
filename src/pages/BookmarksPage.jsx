import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import ImageGrid from '../components/ImageGrid.jsx';
import NeedCookieNotice from '../components/NeedCookieNotice.jsx';
import useSavedSet from '../hooks/useSavedSet.js';

const PAGE_SIZE = 48;

export default function BookmarksPage({ onOpen, onOpenSettings, likedSet }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const sentinelRef = useRef(null);
  const saved = useSavedSet();
  const needCookie = !!error && /cookie|no_cookie|需要 Cookie/i.test(error);

  const load = useCallback(async (append) => {
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const r = await pixivApi.fetchBookmarks({ offset: offsetRef.current, limit: PAGE_SIZE });
      const list = r?.illusts || [];
      offsetRef.current += list.length;
      setItems(prev => (append ? [...prev, ...list] : list));
      setHasMore(list.length >= PAGE_SIZE);
      if (!append && !list.length) setError(r?.message || r?.error || '收藏为空（需要 Cookie）');
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
    setLoadingMore(false);
  }, []);

  useEffect(() => { load(false); }, [load]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loadingMore) load(true);
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadingMore, load]);

  return (
    <div className="page">
      {needCookie
        ? <NeedCookieNotice onOpenSettings={onOpenSettings} />
        : (error && <div className="error-box">{error}</div>)}
      <ImageGrid items={items} savedSet={saved} likedSet={likedSet} onOpen={onOpen} />
      {!loading && hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
      {loadingMore && <div className="hint">加载中...</div>}
      {!loading && !hasMore && items.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}

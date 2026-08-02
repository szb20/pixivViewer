import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import ImageGrid from '../components/ImageGrid.jsx';
import useSavedSet from '../hooks/useSavedSet.js';

const PAGE_SIZE = 20;

export default function DiscoverPage({ onOpen }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const startRef = useRef(0);
  const saved = useSavedSet();

  const load = useCallback(async (append) => {
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const r = await pixivApi.fetchDiscovery({ limit: PAGE_SIZE, start: startRef.current });
      const list = r?.illusts || [];
      startRef.current += list.length;
      setItems(prev => (append ? [...prev, ...list] : list));
      setHasMore(list.length >= PAGE_SIZE);
      if (!append && !list.length) setError(r?.message || r?.error || '推荐为空（需要 Cookie）');
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
    setLoadingMore(false);
  }, []);

  useEffect(() => { load(false); }, [load]);

  return (
    <div className="page">
      <p className="page-desc">每日推荐 — 需要设置 Pixiv Cookie 才能加载</p>
      {loading && <div className="skeleton-grid">{[...Array(4)].map((_, i) => <div key={i} className="skeleton-item" />)}</div>}
      {error && <div className="error-box">{error}</div>}
      <ImageGrid items={items} savedSet={saved} onOpen={onOpen} />
      {!loading && items.length > 0 && (
        <button className="load-more" disabled={loadingMore || !hasMore} onClick={() => load(true)}>
          {loadingMore ? '加载中...' : (hasMore ? '加载更多' : '没有更多了')}
        </button>
      )}
    </div>
  );
}

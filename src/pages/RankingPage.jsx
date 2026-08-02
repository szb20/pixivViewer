import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import ImageGrid from '../components/ImageGrid.jsx';
import useSavedSet from '../hooks/useSavedSet.js';

const MODES = [
  { key: 'daily', label: '日榜' },
  { key: 'weekly', label: '周榜' },
  { key: 'monthly', label: '月榜' },
  { key: 'male', label: '男榜' },
  { key: 'female', label: '女榜' },
  { key: 'rookie', label: '新人' },
  { key: 'original', label: '原创' },
];

export default function RankingPage({ onOpen }) {
  const [mode, setMode] = useState('daily');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const pageRef = useRef(1);
  const saved = useSavedSet();

  const load = useCallback(async (append) => {
    const page = append ? pageRef.current + 1 : 1;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const r = await pixivApi.fetchRanking({ mode, page });
      const list = r?.illusts || [];
      pageRef.current = page;
      setItems(prev => (append ? [...prev, ...list] : list));
      setHasMore(list.length > 0);
      if (!append && !list.length) setError(r?.message || r?.error || '排行榜为空');
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
    setLoadingMore(false);
  }, [mode]);

  useEffect(() => { load(false); }, [load]);

  return (
    <div className="page">
      <div className="chips">
        {MODES.map(m => (
          <button
            key={m.key}
            className={`chip${m.key === mode ? ' active' : ''}`}
            onClick={() => setMode(m.key)}
          >{m.label}</button>
        ))}
      </div>
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

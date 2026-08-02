import { useCallback, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import ImageGrid from '../components/ImageGrid.jsx';
import useSavedSet from '../hooks/useSavedSet.js';

const PAGE_SIZE = 20;
const HISTORY_KEY = 'pixiv_search_history';

export default function SearchPage({ onOpen }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [searched, setSearched] = useState(false);
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  });
  const pageRef = useRef(1);
  const queryRef = useRef('');
  const saved = useSavedSet();

  const doSearch = useCallback(async (q, append) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    if (!append) {
      queryRef.current = trimmed;
      pageRef.current = 1;
      setHistory(prev => {
        const next = [trimmed, ...prev.filter(h => h !== trimmed)].slice(0, 12);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
    }
    const page = append ? pageRef.current + 1 : 1;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); setSearched(true); }
    try {
      const r = await pixivApi.searchPixiv(queryRef.current, { page, count: PAGE_SIZE });
      const list = r?.images || [];
      pageRef.current = page;
      setResults(prev => (append ? [...prev, ...list] : list));
      setHasMore(list.length >= PAGE_SIZE);
      if (!append && !list.length) setError(r?.error || '没有找到结果');
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
    setLoadingMore(false);
  }, []);

  const submit = (e) => { e.preventDefault(); doSearch(query, false); };

  return (
    <div className="page">
      <form className="search-bar" onSubmit={submit}>
        <input
          className="search-input"
          type="text"
          value={query}
          placeholder="搜索 Pixiv 图片..."
          onChange={e => setQuery(e.target.value)}
        />
        <button className="btn-primary" type="submit" disabled={loading}>搜索</button>
      </form>

      {!searched && history.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {history.map(h => (
            <button
              key={h}
              className="history-tag"
              onClick={() => { setQuery(h); doSearch(h, false); }}
            >{h}</button>
          ))}
        </div>
      )}

      {loading && <div className="skeleton-grid">{[...Array(4)].map((_, i) => <div key={i} className="skeleton-item" />)}</div>}
      {error && <div className="error-box">{error}</div>}
      <ImageGrid items={results} savedSet={saved} onOpen={onOpen} />
      {!loading && results.length > 0 && (
        <button className="load-more" disabled={loadingMore || !hasMore} onClick={() => doSearch(queryRef.current, true)}>
          {loadingMore ? '加载中...' : (hasMore ? '加载更多' : '没有更多了')}
        </button>
      )}
    </div>
  );
}

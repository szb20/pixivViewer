import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { saveTabCache, loadTabCache } from '../pixiv-assistant/index.js';
import ImageGrid from '../components/ImageGrid.jsx';
import useSavedSet from '../hooks/useSavedSet.js';

const PAGE_SIZE = 20;
const HISTORY_KEY = 'pixiv_search_history';
const CACHE_KEY = 'search:last';

export default function SearchPage({ onOpen, likedSet, refreshToken = 0, searchSeed = null }) {
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
  const sentinelRef = useRef(null);
  const queryRef = useRef('');
  const resultsRef = useRef([]);
  const doSearchRef = useRef(null);
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
      const nextResults = append ? [...resultsRef.current, ...list] : list;
      resultsRef.current = nextResults;
      setResults(nextResults);
      const nextHasMore = list.length >= PAGE_SIZE;
      setHasMore(nextHasMore);
      if (!append && !list.length) setError(r?.error || '没有找到结果');
      // 持久化最近一次搜索结果（24h TTL），重启后恢复
      saveTabCache(CACHE_KEY, {
        query: queryRef.current,
        results: nextResults,
        hasMore: nextHasMore,
        page,
        searched: true,
      }).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
    setLoadingMore(false);
  }, []);

  const submit = (e) => { e.preventDefault(); doSearch(query, false); };
  doSearchRef.current = doSearch;

  // 挂载时恢复最近一次搜索（不自动发起请求）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cache = await loadTabCache(CACHE_KEY);
        if (cancelled || !cache?.results?.length) return;
        queryRef.current = cache.query || '';
        resultsRef.current = cache.results;
        setQuery(cache.query || '');
        setResults(cache.results);
        setHasMore(!!cache.hasMore);
        if (cache.page > 0) pageRef.current = cache.page;
        if (cache.searched) setSearched(true);
        setLoading(false);
      } catch {
        /* 缓存不可用 */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 重点当前 tab → 重搜当前关键词
  useEffect(() => {
    if (refreshToken > 0 && queryRef.current) doSearchRef.current(queryRef.current, false);
  }, [refreshToken]);

  // 外部触发（详情页点 Tag）→ 直接搜索该 tag
  useEffect(() => {
    if (!searchSeed?.tag) return;
    setQuery(searchSeed.tag);
    doSearchRef.current(searchSeed.tag, false);
  }, [searchSeed]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loadingMore) doSearch(queryRef.current, true);
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadingMore, doSearch]);

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

      {error && <div className="error-box">{error}</div>}
      <ImageGrid items={results} savedSet={saved} likedSet={likedSet} onOpen={onOpen} />
      {!loading && hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
      {loadingMore && <div className="hint">加载中...</div>}
      {!loading && !hasMore && results.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}

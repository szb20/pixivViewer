import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { useTabFeed } from '../hooks/useTabFeed.js';
import { useLikedSet } from '../context/pixivCacheContext.js';
import ImageGrid from '../components/ImageGrid.jsx';
import SearchIcon from '../components/icons/SearchIcon.jsx';
import '../styles/search.css';

const PAGE_SIZE = 20;
const HISTORY_KEY = 'pixiv_search_history';
const CACHE_KEY = 'search:last';

export default function SearchPage({ onOpen, registerRefresh, refreshToken = 0, searchSeed = null }) {
  const likedSet = useLikedSet();
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState(false);
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  });
  const queryRef = useRef('');
  const pageRef = useRef(1);

  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
    registerRefresh,
    refreshToken,
    // 搜索不自动首拉，只有用户提交 / 点历史 / 详情页点 Tag 时才发起
    autoLoad: false,
    hydrate: (cache) => {
      const items = cache?.items || cache?.results || [];
      if (!items.length) return null;
      queryRef.current = cache.query || '';
      setQuery(cache.query || '');
      if (cache.page > 0) pageRef.current = cache.page;
      if (cache.searched) setSearched(true);
      return { items, hasMore: !!cache.hasMore };
    },
    fetchPage: async (append) => {
      const q = queryRef.current.trim();
      if (!q) return null;
      const page = append ? pageRef.current + 1 : 1;
      const r = await pixivApi.searchPixiv(q, { page, count: PAGE_SIZE });
      const list = r?.images || [];
      pageRef.current = page;
      // 有服务端 total 时用它收敛边界，避免最后一页恰好满页时多请求一次空数据
      const serverTotal = r?.total;
      const hasServerTotal = Number.isFinite(serverTotal) && serverTotal > list.length;
      const hasMore = list.length >= PAGE_SIZE
        && (!hasServerTotal || page * PAGE_SIZE < serverTotal);
      return {
        list,
        hasMore,
        emptyMessage: r?.error || '没有找到结果',
        cacheExtra: { query: q, page, searched: true },
      };
    },
  });
  const { load: reload } = feed;

  const runSearch = useCallback((q) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    queryRef.current = trimmed;
    setQuery(trimmed);
    setHistory(prev => {
      const next = [trimmed, ...prev.filter(h => h !== trimmed)].slice(0, 12);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    setSearched(true);
    reload(false);
  }, [reload]);

  const clearHistory = useCallback(() => {
    try { localStorage.removeItem(HISTORY_KEY); } catch {}
    setHistory([]);
  }, []);

  const submit = (e) => { e.preventDefault(); runSearch(query); };

  // 详情页点 Tag → 关闭详情并切到搜索 tab 后直接搜索该 tag
  useEffect(() => {
    if (!searchSeed?.tag) return;
    runSearch(searchSeed.tag);
  }, [searchSeed, runSearch]);

  return (
    <div className="page search-page">
      <div className="search-head">
        {/* 搜索栏：毛玻璃 + 聚焦蓝色光晕 */}
        <form className="search-bar search-bar--glass" onSubmit={submit}>
          <SearchIcon className="search-icon" />
          <input
            className="search-input"
            type="text"
            value={query}
            placeholder="搜索 Pixiv 图片..."
            enterKeyHint="search"
            onChange={e => setQuery(e.target.value)}
          />
          <button className="search-submit" type="submit" disabled={feed.loading}>
            {feed.loading ? <span className="search-submit-spinner" /> : <span>搜索</span>}
          </button>
        </form>

        {/* 历史搜索：毛玻璃 chips */}
        {!searched && history.length > 0 && (
          <div className="search-history">
            <div className="search-history-head">
              <span className="search-history-label">最近搜索</span>
              <button type="button" className="search-history-clear" onClick={clearHistory}>清空</button>
            </div>
            <div className="search-history-tags">
              {history.map(h => (
                <button
                  key={h}
                  type="button"
                  className="search-history-tag"
                  onClick={() => runSearch(h)}
                >{h}</button>
              ))}
            </div>
          </div>
        )}

        {feed.error && (
          <div className="error-box">
            {feed.error}
            <button type="button" className="error-retry" onClick={() => runSearch(queryRef.current || query)}>重试</button>
          </div>
        )}
      </div>

      <ImageGrid items={feed.items} likedSet={likedSet} onOpen={onOpen} />
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
      {feed.loadingMore && <div className="hint">加载中...</div>}
      {!feed.loading && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pixivApi } from '../api/pixiv.js';
import { useTabFeed } from '../hooks/useTabFeed.js';
import { useLikedSet } from '../context/pixivCacheContext.js';
import ImageGrid from '../components/ImageGrid.jsx';
import SearchIcon from '../components/icons/SearchIcon.jsx';
import { appStorage, migrateFromLegacyKey } from '../utils/appStorage.js';
import { getMainScrollEl } from '../utils/scroll.js';
import '../styles/search.css';

const PAGE_SIZE = 20;
const CACHE_KEY = 'search:last';
const HISTORY_KEY = 'searchHistory';
const HISTORY_LIMIT = 12;

function normalizeHistory(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const next = [];
  for (const raw of list) {
    const item = String(raw || '').trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
    if (next.length >= HISTORY_LIMIT) break;
  }
  return next;
}

// 迁移旧版独立历史 key → 统一 key
migrateFromLegacyKey('pixiv_search_history', HISTORY_KEY);

export default function SearchPage({ active = true, onOpen, registerRefresh, refreshToken = 0, searchSeed = null }) {
  const likedSet = useLikedSet();
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState(false);
  const [history, setHistory] = useState(() => {
    const normalized = normalizeHistory(appStorage.get(HISTORY_KEY, []));
    appStorage.set(HISTORY_KEY, normalized);
    return normalized;
  });
  const [searchFocused, setSearchFocused] = useState(false);
  const [hideBar, setHideBar] = useState(false); // 滚动时弹入/弹出搜索栏（同筛选栏）
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
      const next = normalizeHistory([trimmed, ...prev]);
      appStorage.set(HISTORY_KEY, next);
      return next;
    });
    setSearched(true);
    reload(false);
  }, [reload]);

  const clearHistory = useCallback(() => {
    appStorage.remove(HISTORY_KEY);
    setHistory([]);
  }, []);

  const removeHistory = useCallback((item) => {
    setHistory(prev => {
      const key = String(item || '').trim().toLowerCase();
      const next = prev.filter(h => h.toLowerCase() !== key);
      if (next.length) appStorage.set(HISTORY_KEY, next);
      else appStorage.remove(HISTORY_KEY);
      return next;
    });
  }, []);

  const submit = (e) => { e.preventDefault(); runSearch(query); };
  const showHistory = history.length > 0 && (!searched || searchFocused);

  // 详情页点 Tag → 关闭详情并切到搜索 tab 后直接搜索该 tag
  useEffect(() => {
    if (!searchSeed?.tag) return;
    runSearch(searchSeed.tag);
  }, [searchSeed, runSearch]);

  // 滚动收起：上下滑动都隐藏搜索栏（弹出靠双击当前 Tab）
  useEffect(() => {
    const el = getMainScrollEl();
    if (!el) return;
    let last = el.scrollTop;
    const onScroll = () => {
      const t = el.scrollTop;
      if (Math.abs(t - last) > 20) setHideBar(true);
      last = t;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 点击弹出：双击当前 Tab（refreshToken 触发）→ 弹出搜索栏
  useEffect(() => {
    if (refreshToken > 0) setHideBar(false);
  }, [refreshToken]);

  return (
    <div className="page search-page">
      <div className="search-head">
        {showHistory && (
          <div className="search-history">
            <div className="search-history-head">
              <span className="search-history-label">最近搜索</span>
              <button type="button" className="search-history-clear" onClick={clearHistory}>清空</button>
            </div>
            <div className="search-history-tags">
              {history.map(h => (
                <span className="search-history-chip" key={h}>
                  <button
                    type="button"
                    className="search-history-tag"
                    onClick={() => runSearch(h)}
                  >{h}</button>
                  <button
                    type="button"
                    className="search-history-delete"
                    aria-label={`删除 ${h}`}
                    onClick={(e) => { e.stopPropagation(); removeHistory(h); }}
                  >×</button>
                </span>
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

      {createPortal(
        <form
          className={`search-bar search-bar--top${hideBar ? ' search-bar--hidden' : ''}`}
          style={{ display: active ? 'flex' : 'none' }}
          onSubmit={submit}
        >
          <input
            className="search-input"
            type="text"
            value={query}
            placeholder="标签 / 作品ID"
            enterKeyHint="search"
            onFocus={() => { setSearchFocused(true); setHideBar(false); }}
            onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
            onChange={e => setQuery(e.target.value)}
          />
          <button className="search-submit" type="submit" disabled={feed.loading} aria-label="搜索">
            {feed.loading ? <span className="search-submit-spinner" /> : <SearchIcon className="search-submit-icon" />}
          </button>
        </form>,
        document.querySelector('.app')
      )}
    </div>
  );
}

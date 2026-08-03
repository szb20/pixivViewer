import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { saveTabCache, loadTabCache } from '../pixiv-assistant/index.js';
import ImageGrid from '../components/ImageGrid.jsx';
import NeedCookieNotice from '../components/NeedCookieNotice.jsx';

const PAGE_SIZE = 48;
const CACHE_KEY = 'bookmarks';

export default function BookmarksPage({ onOpen, onOpenSettings, likedSet, registerRefresh, refreshToken = 0 }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const itemsRef = useRef([]);
  const sentinelRef = useRef(null);
  const [hydrated, setHydrated] = useState(false);
  const cacheUsedRef = useRef(false);
  const firstFetchDoneRef = useRef(false);
  const loadRef = useRef(null);
  const needCookie = !!error && /cookie|no_cookie|需要 Cookie/i.test(error);

  const load = useCallback(async (append) => {
    if (!append) offsetRef.current = 0;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const r = await pixivApi.fetchBookmarks({ offset: offsetRef.current, limit: PAGE_SIZE });
      // fetchBookmarks 返回的字段是 works（收藏列表），不是 illusts
      const list = r?.works || [];
      offsetRef.current += list.length;
      const nextItems = append ? [...itemsRef.current, ...list] : list;
      itemsRef.current = nextItems;
      setItems(nextItems);
      const nextHasMore = list.length >= PAGE_SIZE;
      setHasMore(nextHasMore);
      if (!append && !list.length) setError(r?.message || r?.error || '收藏为空');
      saveTabCache(CACHE_KEY, { items: nextItems, hasMore: nextHasMore, offset: offsetRef.current }).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
    setLoadingMore(false);
  }, []);

  loadRef.current = load;

  // 注册下拉刷新入口（当前 tab 有效）
  useEffect(() => {
    if (!registerRefresh) return;
    return registerRefresh('bookmarks', () => loadRef.current?.(false));
  }, [registerRefresh]);

  // 挂载时先尝试恢复缓存；缓存命中则跳过首次请求
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cache = await loadTabCache(CACHE_KEY);
        if (cancelled || !cache?.items?.length) return;
        cacheUsedRef.current = true;
          itemsRef.current = cache.items;
          setItems(cache.items);
          setHasMore(!!cache.hasMore);
          if (cache.offset > 0) offsetRef.current = cache.offset;
          setLoading(false);
      } catch {
        /* 缓存不可用 → 走网络 */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!firstFetchDoneRef.current) {
      firstFetchDoneRef.current = true;
      if (cacheUsedRef.current) return; // 缓存恢复 → 跳过首次请求
    }
    load(false);
  }, [load, hydrated]);

  // 重点当前 tab → 强制刷新
  useEffect(() => {
    if (refreshToken > 0) loadRef.current(false);
  }, [refreshToken]);

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
        : (error && (
          <div className="error-box">
            {error}
            <button className="error-retry" onClick={() => load(false)}>重试</button>
          </div>
        ))}
      <ImageGrid items={items} likedSet={likedSet} onOpen={onOpen} />
      {!loading && hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
      {loadingMore && <div className="hint">加载中...</div>}
      {!loading && !hasMore && items.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}

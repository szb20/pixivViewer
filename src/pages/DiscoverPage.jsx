import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { saveTabCache, loadTabCache } from '../pixiv-assistant/index.js';
import ImageGrid from '../components/ImageGrid.jsx';
import NeedCookieNotice from '../components/NeedCookieNotice.jsx';
import { createLogger } from '../utils/logger.js';

const PAGE_SIZE = 20;
const CACHE_KEY = 'discover';
const log = createLogger('Discover');

export default function DiscoverPage({ onOpen, onOpenSettings, likedSet, savedSet, registerRefresh, refreshToken = 0 }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const startRef = useRef(0);
  const itemsRef = useRef([]);
  const sentinelRef = useRef(null);
  const [hydrated, setHydrated] = useState(false);
  const cacheUsedRef = useRef(false);
  const firstFetchDoneRef = useRef(false);
  const loadRef = useRef(null);
  const saved = savedSet;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const needCookie = !!error && /cookie|no_cookie|需要 Cookie/i.test(error);

  const load = useCallback(async (append) => {
    if (!append) startRef.current = 0;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const r = await pixivApi.fetchDiscovery({ limit: PAGE_SIZE, start: startRef.current });
      const rawList = r?.illusts || [];
      log.warn('[discover-load] append:', append, 'start:', startRef.current, 'raw:', rawList.length, 'err:', r?.error || '');
      // 过滤已保存到相册的 + 去重（discovery 可能重复返回同一批）
      const seen = new Set(itemsRef.current.map(i => i.illustId));
      const filtered = rawList.filter(img => {
        if (savedRef.current?.size && savedRef.current.has(`${img.illustId}_0`)) return false;
        return !seen.has(img.illustId);
      });
      startRef.current += rawList.length;
      const nextItems = append ? [...itemsRef.current, ...filtered] : filtered;
      itemsRef.current = nextItems;
      setItems(nextItems);
      // 有返回且本页有新内容才继续加载（避免 discovery 返回数量不足 20 时过早停止）
      const nextHasMore = rawList.length > 0 && filtered.length > 0;
      setHasMore(nextHasMore);
      if (!append && !filtered.length) setError(r?.message || r?.error || '推荐为空（需要 Cookie）');
      saveTabCache(CACHE_KEY, { items: nextItems, hasMore: nextHasMore, start: startRef.current }).catch(() => {});
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
    return registerRefresh('discover', () => loadRef.current?.(false));
  }, [registerRefresh]);

  // 挂载时先尝试恢复缓存；缓存命中则跳过首次请求
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cache = await loadTabCache(CACHE_KEY);
        log.warn('[discover-mount] cache items:', cache?.items?.length, 'hasMore:', cache?.hasMore, 'start:', cache?.start);
        if (cancelled || !cache?.items?.length) return;
        // 缓存 hasMore=false（可能是不足一页的旧缓存）时不跳过网络请求，确保能继续加载
        cacheUsedRef.current = !!cache.hasMore;
          itemsRef.current = cache.items;
          setItems(cache.items);
          setHasMore(!!cache.hasMore);
          if (cache.start > 0) startRef.current = cache.start;
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

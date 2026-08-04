/**
 * useTabFeed — Tab 页公共骨架：缓存水合 + 无限滚动 + 下拉刷新/强制刷新。
 *
 * 原先 Discover / Ranking / Bookmarks / Search 四个页面各自重复实现：
 *   - loadTabCache 水合 → hydrated → firstFetchDoneRef 首拉 gating
 *   - sentinelRef + IntersectionObserver 无限滚动
 *   - loadRef + registerRefresh / refreshToken 刷新
 *   - loading / loadingMore / error / hasMore 状态机
 *   - itemsRef 双缓冲避免闭包陷阱
 *
 * 现收敛到本 hook，各页面只需提供 fetchPage 与 hydrate：
 *
 * @param {object}  opts
 * @param {string}  opts.cacheKey          持久化缓存的 key（同时作为下拉刷新注册名）
 * @param {function} [opts.registerRefresh] App 传入的回调注册器
 * @param {number}  [opts.refreshToken]     强制刷新令牌（重点当前 tab 时 +1）
 * @param {function} opts.fetchPage         async (append, currentItems) => ({
 *                                            list, hasMore, cacheExtra, emptyMessage
 *                                          }) | null
 *                                          - list 已过滤/去重；cacheExtra 是持久化附加字段
 *                                          - 返回 null 表示本次不加载（如搜索无关键词）
 * @param {function} [opts.hydrate]         (cache) => ({ items, hasMore }) | null
 *                                          - 负责恢复游标/查询等副作用，返回 null 表示不水合
 * @param {function} [opts.shouldSkipFirstFetch] (applied) => boolean
 *                                          - 水合命中后是否跳过首拉，默认 () => true
 * @param {boolean}  [opts.autoLoad=true]   挂载后是否自动首拉（Search 传 false）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadTabCache, saveTabCache } from '../pixiv-assistant/index.js';
import { useStableCallback } from './useStableCallback.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('useTabFeed');

export function useTabFeed({
  cacheKey,
  registerRefresh,
  refreshToken = 0,
  fetchPage,
  hydrate,
  shouldSkipFirstFetch = () => true,
  autoLoad = true,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(autoLoad);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const sentinelRef = useRef(null);
  const itemsRef = useRef([]);
  const cacheUsedRef = useRef(false);
  const firstFetchDoneRef = useRef(false);
  const loadingRef = useRef(false);

  const fetchPageStable = useStableCallback(fetchPage);
  const hydrateStable = useStableCallback(hydrate);
  const skipFirstFetchStable = useStableCallback(shouldSkipFirstFetch);

  const load = useCallback(async (append) => {
    if (loadingRef.current) {
      log.debug('[load] 跳过重复加载, append:', append);
      return;
    }
    loadingRef.current = true;

    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }

    try {
      const r = await fetchPageStable(append, itemsRef.current);
      if (r == null) {
        log.debug('[load] fetchPage 返回 null，跳过');
        return;
      }
      const nextItems = append ? [...itemsRef.current, ...(r.list || [])] : (r.list || []);
      itemsRef.current = nextItems;
      setItems(nextItems);
      setHasMore(!!r.hasMore);
      if (r.cacheExtra) {
        saveTabCache(cacheKey, { ...r.cacheExtra, items: nextItems, hasMore: !!r.hasMore })
          .catch(() => { });
      }
      if (!append && !nextItems.length) setError(r.emptyMessage || '');
    } catch (e) {
      log.warn('[load] 失败:', e?.message || e);
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
      setLoadingMore(false);
      loadingRef.current = false;
    }
  }, [cacheKey, fetchPageStable]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!registerRefresh) return;
    return registerRefresh(cacheKey, () => loadRef.current?.(false));
  }, [registerRefresh, cacheKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cache = await loadTabCache(cacheKey);
        if (cancelled || !cache) return;
        const applied = hydrateStable(cache);
        if (!applied) return;
        cacheUsedRef.current = !!skipFirstFetchStable(applied);
        itemsRef.current = applied.items || [];
        setItems(applied.items || []);
        setHasMore(!!applied.hasMore);
        setLoading(false);
        log.debug('[hydrate] 缓存命中, items:', applied.items?.length || 0);
      } catch {
        /* 缓存不可用 → 走网络 */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [cacheKey, hydrateStable, skipFirstFetchStable]);

  useEffect(() => {
    if (!hydrated || !autoLoad) return;
    if (!firstFetchDoneRef.current) {
      firstFetchDoneRef.current = true;
      if (cacheUsedRef.current) {
        log.debug('[firstFetch] 缓存命中，跳过首拉');
        return;
      }
    }
    load(false);
  }, [load, hydrated, autoLoad]);

  useEffect(() => {
    if (refreshToken > 0) {
      log.debug('[refreshToken] 强制刷新, token:', refreshToken);
      loadRef.current?.(false);
    }
  }, [refreshToken]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loadingMore && !loadingRef.current) {
        log.debug('[sentinel] 触底，加载更多');
        load(true);
      }
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadingMore, load]);

  return { items, setItems, loading, loadingMore, error, hasMore, sentinelRef, hydrated, load };
}
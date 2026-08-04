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

  // 页面提供的回调每次渲染都是新引用，统一走 ref，避免 effect 反复触发
  const fetchPageRef = useRef(fetchPage);
  fetchPageRef.current = fetchPage;
  const hydrateRef = useRef(hydrate);
  hydrateRef.current = hydrate;
  const skipRef = useRef(shouldSkipFirstFetch);
  skipRef.current = shouldSkipFirstFetch;

  const load = useCallback(async (append) => {
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const r = await fetchPageRef.current(append, itemsRef.current);
      if (r == null) return; // 页面选择不加载
      const nextItems = append ? [...itemsRef.current, ...(r.list || [])] : (r.list || []);
      itemsRef.current = nextItems;
      setItems(nextItems);
      setHasMore(!!r.hasMore);
      if (r.cacheExtra) {
        saveTabCache(cacheKey, { ...r.cacheExtra, items: nextItems, hasMore: !!r.hasMore })
          .catch(() => {});
      }
      if (!append && !nextItems.length) setError(r.emptyMessage || '');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [cacheKey]);

  const loadRef = useRef(load);
  loadRef.current = load;

  // 注册下拉刷新入口（当前 tab 生效）
  useEffect(() => {
    if (!registerRefresh) return;
    return registerRefresh(cacheKey, () => loadRef.current?.(false));
  }, [registerRefresh, cacheKey]);

  // 挂载时先尝试恢复缓存；缓存命中则跳过首次请求
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cache = await loadTabCache(cacheKey);
        if (cancelled || !cache) return;
        const applied = hydrateRef.current?.(cache);
        if (!applied) return;
        cacheUsedRef.current = !!skipRef.current(applied);
        itemsRef.current = applied.items || [];
        setItems(applied.items || []);
        setHasMore(!!applied.hasMore);
        setLoading(false);
      } catch {
        /* 缓存不可用 → 走网络 */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [cacheKey]);

  // 首拉 gating：已水合后，若缓存未命中（cacheUsed=false）才发首次请求
  useEffect(() => {
    if (!hydrated || !autoLoad) return;
    if (!firstFetchDoneRef.current) {
      firstFetchDoneRef.current = true;
      if (cacheUsedRef.current) return; // 水合命中 → 跳过首拉
    }
    load(false);
  }, [load, hydrated, autoLoad]);

  // 重点当前 tab → 强制刷新
  useEffect(() => {
    if (refreshToken > 0) loadRef.current?.(false);
  }, [refreshToken]);

  // 哨兵触底自动加载
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loadingMore) load(true);
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadingMore, load]);

  return { items, setItems, loading, loadingMore, error, hasMore, sentinelRef, hydrated, load };
}

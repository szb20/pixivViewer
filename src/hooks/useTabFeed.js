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
 * @param {string}  opts.cacheKey          持久化缓存的 key（已含来源前缀）
 * @param {string}  [opts.refreshKey]      下拉刷新注册名（默认同 cacheKey）。
 *                                         来源前缀会进 cacheKey，但 store 的
 *                                         triggerPullRefresh 按 activeTab（'discover'）取，
 *                                         两者不一致时刷新会静默失效。
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
 * @param {boolean}  [opts.enabled=true]    是否允许水合和请求（例如等待启动缓存扫描）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadTabCache, saveTabCache } from '../pixiv-assistant/index.js';
import { useStableCallback } from './useStableCallback.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('useTabFeed');

export function useTabFeed({
  cacheKey,
  refreshKey,
  registerRefresh,
  refreshToken = 0,
  fetchPage,
  hydrate,
  shouldSkipFirstFetch = () => true,
  autoLoad = true,
  enabled = true,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(autoLoad);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [appendError, setAppendError] = useState(null); // 触底翻页失败（区别于 error：不清空已有列表）
  const [hasMore, setHasMore] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const sentinelRef = useRef(null);
  const itemsRef = useRef([]);
  const cacheUsedRef = useRef(false);
  const firstFetchDoneRef = useRef(false);
  const loadingRef = useRef(false);
  const loadSeqRef = useRef(0);

  const fetchPageStable = useStableCallback(fetchPage);
  const hydrateStable = useStableCallback(hydrate);
  const skipFirstFetchStable = useStableCallback(shouldSkipFirstFetch);

  const load = useCallback(async (append) => {
    if (!enabled) return;
    // 追加加载（触底翻页）仍做并发去重，避免 sentinel 重复触发；
    // 全新加载（切换关键词/刷新）允许取代在途请求，避免新请求被静默丢弃。
    if (loadingRef.current && append) {
      log.debug('[load] 跳过重复追加加载');
      return;
    }
    const seq = ++loadSeqRef.current;
    loadingRef.current = true;

    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); setAppendError(null); }

    try {
      // 第三个参数 isStale：让调用方在 await 之后判断本次请求是否已被取代。
      // 页面把翻页游标推进放在 await 之后，若不判断，被丢弃的响应仍会推进游标 → 跳页。
      const r = await fetchPageStable(append, itemsRef.current, () => seq !== loadSeqRef.current);
      if (seq !== loadSeqRef.current) return; // 已被更新的请求取代，丢弃过期响应（副作用由调用方自行回滚）
      if (r == null) {
        log.debug('[load] fetchPage 返回 null，跳过');
        return;
      }
      const nextItems = append ? [...itemsRef.current, ...(r.list || [])] : (r.list || []);
      itemsRef.current = nextItems;
      setItems(nextItems);
      // 失败（服务端返回 error 且无数据）不能当成"没有更多了"：收起哨兵避免自动重试风暴，
      // 改由页面依据 appendError 渲染"点击重试"
      const failed = !(r.list || []).length && !!r.error;
      setHasMore(failed && append ? false : !!r.hasMore);
      setAppendError(failed && append ? r.error : null);
      if (r.cacheExtra) {
        saveTabCache(cacheKey, { ...r.cacheExtra, items: nextItems, hasMore: !!r.hasMore })
          .catch(() => { });
      }
      if (!append && !nextItems.length) setError(failed ? r.error : (r.emptyMessage || ''));
    } catch (e) {
      if (seq !== loadSeqRef.current) return;
      log.warn('[load] 失败:', e?.message || e);
      if (append) setAppendError(e.message || '加载失败');
      else setError(e.message || '加载失败');
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
        loadingRef.current = false;
      }
    }
  }, [cacheKey, enabled, fetchPageStable]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!registerRefresh) return;
    return registerRefresh(refreshKey || cacheKey, () => loadRef.current?.(false));
  }, [registerRefresh, cacheKey, refreshKey]);

  useEffect(() => {
    if (!enabled) return;
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
  }, [cacheKey, enabled, hydrateStable, skipFirstFetchStable]);

  useEffect(() => {
    if (!enabled || !hydrated || !autoLoad) return;
    if (!firstFetchDoneRef.current) {
      firstFetchDoneRef.current = true;
      if (cacheUsedRef.current) {
        log.debug('[firstFetch] 缓存命中，跳过首拉');
        return;
      }
    }
    load(false);
  }, [load, enabled, hydrated, autoLoad]);

  // 强制刷新令牌（重点当前 tab 时 +1）。
  // 跳过挂载那一次：切来源会整块重挂载组件，此时 token 往往已 > 0，
  // 若照单全收就会在水合/首拉之外多发一次重复请求。
  const lastTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken > 0 && refreshToken !== lastTokenRef.current) {
      log.debug('[refreshToken] 强制刷新, token:', refreshToken);
      loadRef.current?.(false);
    }
    lastTokenRef.current = refreshToken;
  }, [refreshToken]);

  useEffect(() => {
    const el = sentinelRef.current;
    // appendError 时收起哨兵：抛异常的翻页失败不会把 hasMore 置 false，若不拦，
    // observer 会随 loadingMore 的翻转重建、重建时的初始回调立即再触发 load，
    // 形成与失败速度同频的重试风暴。失败后的唯一出口是页面渲染的「点击重试」。
    if (!el || !hasMore || loading || appendError) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loadingMore && !loadingRef.current) {
        log.debug('[sentinel] 触底，加载更多');
        load(true);
      }
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadingMore, load, appendError]);

  // 触底翻页失败后的重试：仍走 append（失败时游标未推进，重试即重拉同一页）
  const retryAppend = useCallback(() => load(true), [load]);

  return { items, setItems, loading, loadingMore, error, appendError, retryAppend, hasMore, sentinelRef, hydrated, load };
}

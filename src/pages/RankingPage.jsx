import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { saveTabCache, loadTabCache, scopedTabKey } from '../pixiv-assistant/index.js';
import { useLikedSet } from '../context/pixivCacheContext.js';
import ImageGrid from '../components/ImageGrid.jsx';
import { useImageSourceId } from '../hooks/useImageSource.js';
import { booruApiFor } from '../sources/api.js';
import { getRankingModes, clampRankingCategory, R18_CATEGORIES } from '../utils/rankingModes.js';
import { showToast } from '../utils/toast.js';
import { useAppStore } from '../store/useAppStore.js';

const CACHE_KEY = 'ranking';
/** booru 的 popular_recent 一次返回整批，不分页 */
const BOORU_LIMIT = 60;

export default function RankingPage({ onOpen, registerRefresh, refreshToken = 0 }) {
  const likedSet = useLikedSet();
  const sourceId = useImageSourceId();
  const booruApi = booruApiFor(sourceId);
  const isBooru = !!booruApi;
  const { modes } = getRankingModes(sourceId);
  const cacheKey = scopedTabKey(sourceId, CACHE_KEY);
  // 档位与 R18 放在 store：侧边栏 / 抽屉的二级项驱动它
  const rawCategory = useAppStore(s => s.rankingCategory);
  const r18 = useAppStore(s => s.rankingR18);
  const setRankingSelection = useAppStore(s => s.setRankingSelection);
  // 切来源会按 key 重挂载本页，但档位留在 store 里：booru 的档位 key 与 pixiv 不通用，
  // 这里按当前来源的可用档位兜底（不写回 store，切回 pixiv 仍记得原来的档）
  const category = clampRankingCategory(modes, rawCategory);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [appendError, setAppendError] = useState(null); // 翻页失败：单独提示，不占用"没有更多了"
  const [hasMore, setHasMore] = useState(true);
  const pageRef = useRef(1);
  const itemsRef = useRef([]);
  const sentinelRef = useRef(null);
  const [hydrated, setHydrated] = useState(false);
  const cacheUsedRef = useRef(false);
  const firstFetchDoneRef = useRef(false);
  const loadRef = useRef(null);
  const cacheRef = useRef(new Map()); // mode → { items, hasMore, page } 内存缓存
  const fetchSeqRef = useRef(0); // 防止快速切档时旧响应覆盖新内容
  const loadedModeRef = useRef(null); // 当前 items 属于哪个 mode
  const loadingRef = useRef(false); // 同步并发锁：避免触底哨兵连续触发重复翻页
  const mode = isBooru
    ? category
    : (r18 && R18_CATEGORIES.has(category) ? `${category}_r18` : category);

  const load = useCallback(async (append, { keepOnFail = false } = {}) => {
    if (loadingRef.current && append) return;
    loadingRef.current = true;
    const page = append ? pageRef.current + 1 : 1;
    const seq = ++fetchSeqRef.current;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }

    // 刷新失败但手里已有内容：保留列表 + 轻提示，不把正在看的榜单换成错误框。
    // 只对「刷新」生效（keepOnFail）—— 换档位失败必须清空，否则会把上一档的内容留在新档位下面
    const refreshFailed = (msg) => {
      if (!keepOnFail || !itemsRef.current.length || loadedModeRef.current !== mode) return false;
      showToast(msg || '刷新失败，请检查网络', { type: 'error' });
      return true;
    };

    // 切换档位（非首次且 mode 变化）：先秒开内存缓存，或清空显示加载态，后台再拉新数据
    if (!append && loadedModeRef.current !== null && loadedModeRef.current !== mode) {
      const hit = cacheRef.current.get(mode);
      if (hit) {
        itemsRef.current = hit.items;
        setItems(hit.items);
        setHasMore(hit.hasMore);
        pageRef.current = hit.page;
        setLoading(false); // 有缓存：不转圈，后台刷新
      } else {
        itemsRef.current = [];
        setItems([]);
        setHasMore(true);
        pageRef.current = 1;
      }
      loadedModeRef.current = mode;
    }

    try {
      // 非 Pixiv：popular_recent 一次给全（实测无分页参数），不做触底翻页
      if (isBooru) {
        const r = await booruApi.popular({ period: mode, limit: BOORU_LIMIT });
        if (seq !== fetchSeqRef.current) return;
        const list = r?.illusts || [];
        const failed = !list.length && !!r?.error;
        if (failed && refreshFailed(r?.error)) return; // 刷新失败：旧列表原样留着
        itemsRef.current = list;
        setItems(list);
        setHasMore(false);
        setAppendError(null);
        loadedModeRef.current = mode;
        cacheRef.current.set(mode, { items: list, hasMore: false, page: 1 });
        if (!list.length) setError(r?.error || '排行榜为空');
        // 失败时不落盘：写进去的是空列表，等于把可用缓存覆写成空
        if (!failed) {
          saveTabCache(cacheKey, { category, mode, items: list, hasMore: false, page: 1 }).catch(() => { });
        }
        return;
      }

      const r = await pixivApi.fetchRanking({ mode, page });
      if (seq !== fetchSeqRef.current) return; // 用户已切走，丢弃过期响应
      const rawList = r?.illusts || [];
      const filtered = rawList;
      // fetchRanking 内部 catch 后返回 { illusts: [], error }，失败不能当成"没有更多了"
      const failed = !rawList.length && !!(r?.error || r?.message);
      if (failed && !append && refreshFailed(r?.error || r?.message)) return; // 刷新失败：旧列表原样留着
      if (!failed) pageRef.current = page; // 失败不推进游标，重试才会重拉同一页
      const nextItems = append ? [...itemsRef.current, ...filtered] : filtered;
      itemsRef.current = nextItems;
      setItems(nextItems);
      // 失败时收起哨兵（避免自动重试风暴），由 appendError 渲染"点击重试"
      const nextHasMore = failed && append ? false : rawList.length > 0;
      setHasMore(nextHasMore);
      setAppendError(failed && append ? (r.error || r.message) : null);
      if (!append) {
        loadedModeRef.current = mode;
        cacheRef.current.set(mode, { items: nextItems, hasMore: nextHasMore, page: pageRef.current });
      }
      if (!append && !filtered.length) setError(r?.message || r?.error || '排行榜为空');
      // 持久化缓存（24h TTL）：重启 App 后直接恢复。
      // 失败时不写：这次 nextItems 是空的（或没变化），写进去等于把可用缓存覆写成空，
      // 一次网络抖动就把离线秒开的能力删掉，而日志里什么都看不到
      if (!failed) {
        saveTabCache(cacheKey, { category, r18, items: nextItems, hasMore: nextHasMore, page: pageRef.current }).catch(() => { });
      }
    } catch (e) {
      if (seq !== fetchSeqRef.current) return; // 已被切档取代，不写错误
      if (append) setAppendError(e.message || '加载失败');
      else setError(e.message);
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
        loadingRef.current = false;
      }
    }
  }, [mode, category, r18, isBooru, booruApi, cacheKey]);

  loadRef.current = load;

  // 注册下拉刷新入口（当前 tab 有效）
  useEffect(() => {
    if (!registerRefresh) return;
    // keepOnFail：下拉刷新失败时保留当前列表（见 load 里的说明）
    return registerRefresh('ranking', () => loadRef.current?.(false, { keepOnFail: true }));
  }, [registerRefresh]);

  // 挂载时先尝试恢复缓存；缓存命中则跳过首次请求
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cache = await loadTabCache(cacheKey);
        if (cancelled || !cache?.items?.length) return;
        cacheUsedRef.current = true;
        // 档位与 R18 来自同一条缓存记录，必须一次写入，避免被「选档位联动 R18」的规则改写
        setRankingSelection({ category: cache.category, r18: cache.r18 });
        const hydratedR18 = typeof cache.r18 === 'boolean' ? cache.r18 : false;
        loadedModeRef.current = cache.mode
          || ((hydratedR18 && R18_CATEGORIES.has(cache.category)) ? `${cache.category}_r18` : (cache.category || 'daily'));
        cacheRef.current.set(loadedModeRef.current, {
          items: cache.items,
          hasMore: !!cache.hasMore,
          page: cache.page > 0 ? cache.page : 1,
        });
        itemsRef.current = cache.items;
        setItems(cache.items);
        setHasMore(!!cache.hasMore);
        if (cache.page > 0) pageRef.current = cache.page;
        setLoading(false);
      } catch {
        /* 缓存不可用 → 走网络 */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
    // setRankingSelection 是 zustand action，引用稳定，加进来只为满足 exhaustive-deps
  }, [cacheKey, setRankingSelection]);

  // 切换档位（mode 变化）时重新加载；已挂载后不再重复首次请求
  useEffect(() => {
    if (!hydrated) return;
    if (!firstFetchDoneRef.current) {
      firstFetchDoneRef.current = true;
      if (cacheUsedRef.current) return; // 缓存恢复 → 跳过首次请求
    }
    load(false);
  }, [load, hydrated]);

  // 点击当前 tab → 刷新当前档位。
  // 跳过挂载那一次：切来源会整块重挂载，若沿用旧 token 会在挂载时多打一次网络。
  const lastTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken > 0 && refreshToken !== lastTokenRef.current) {
      loadRef.current(false, { keepOnFail: true });
    }
    lastTokenRef.current = refreshToken;
  }, [refreshToken]);

  // 哨兵触底自动加载（仅 Pixiv 有翻页）
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loadingMore && !loadingRef.current) load(true);
    }, { rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadingMore, load]);

  return (
    <div className="page">
      {error && (
        <div className="error-box">
          {error}
          <button className="error-retry" onClick={() => load(false)}>重试</button>
        </div>
      )}
      <ImageGrid items={items} likedSet={likedSet} onOpen={onOpen} />
      {loading && items.length === 0 && <div className="hint">加载中...</div>}
      {!loading && hasMore && (
        <div ref={sentinelRef} style={{ height: 1 }} />
      )}
      {loadingMore && <div className="hint">加载中...</div>}
      {!loading && appendError && (
        <div className="hint hint--error" onClick={() => load(true)} role="button">
          加载失败，点击重试
        </div>
      )}
      {!loading && !appendError && !hasMore && items.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}

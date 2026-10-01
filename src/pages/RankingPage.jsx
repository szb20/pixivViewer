import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { saveTabCache, loadTabCache, scopedTabKey } from '../pixiv-assistant/index.js';
import { useLikedSet } from '../context/pixivCacheContext.js';
import ImageGrid from '../components/ImageGrid.jsx';
import { getMainScrollEl } from '../utils/scroll.js';
import { useImageSourceId } from '../hooks/useImageSource.js';
import { booruApiFor } from '../sources/api.js';

const CACHE_KEY = 'ranking';
/** booru 的 popular_recent 一次返回整批，不分页 */
const BOORU_LIMIT = 60;

const MODES = [
  { key: 'daily', label: '日榜' },
  { key: 'weekly', label: '周榜' },
  { key: 'monthly', label: '月榜' },
  { key: 'male', label: '男性向' },
  { key: 'female', label: '女性向' },
  { key: 'rookie', label: '新人' },
  { key: 'original', label: '原创' },
  { key: 'r18g', label: 'R18G' },
];

/** 非 Pixiv 来源：popular_recent 的日 / 周 / 月三档 */
const BOORU_MODES = [
  { key: '1d', label: '日榜' },
  { key: '1w', label: '周榜' },
  { key: '1m', label: '月榜' },
];

// 支持 R-18 变体的分类（monthly / rookie / original 无 R18 档）
const R18_CATEGORIES = new Set(['daily', 'weekly', 'male', 'female']);

export default function RankingPage({ active = true, onOpen, registerRefresh, refreshToken = 0 }) {
  const likedSet = useLikedSet();
  const sourceId = useImageSourceId();
  const booruApi = booruApiFor(sourceId);
  const isBooru = !!booruApi;
  const modes = isBooru ? BOORU_MODES : MODES;
  const cacheKey = scopedTabKey(sourceId, CACHE_KEY);
  const [category, setCategory] = useState(isBooru ? BOORU_MODES[0].key : 'daily');
  const [r18, setR18] = useState(true);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [appendError, setAppendError] = useState(null); // 翻页失败：单独提示，不占用"没有更多了"
  const [hasMore, setHasMore] = useState(true);
  const [showFilters, setShowFilters] = useState(true);
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

  const load = useCallback(async (append) => {
    if (loadingRef.current && append) return;
    loadingRef.current = true;
    const page = append ? pageRef.current + 1 : 1;
    const seq = ++fetchSeqRef.current;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }

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
        itemsRef.current = list;
        setItems(list);
        setHasMore(false);
        setAppendError(null);
        loadedModeRef.current = mode;
        cacheRef.current.set(mode, { items: list, hasMore: false, page: 1 });
        if (!list.length) setError(r?.error || '排行榜为空');
        saveTabCache(cacheKey, { category, mode, items: list, hasMore: false, page: 1 }).catch(() => { });
        if (failed) setError(r.error);
        return;
      }

      const r = await pixivApi.fetchRanking({ mode, page });
      if (seq !== fetchSeqRef.current) return; // 用户已切走，丢弃过期响应
      const rawList = r?.illusts || [];
      const filtered = rawList;
      // fetchRanking 内部 catch 后返回 { illusts: [], error }，失败不能当成"没有更多了"
      const failed = !rawList.length && !!(r?.error || r?.message);
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
      // 持久化缓存（24h TTL）：重启 App 后直接恢复
      saveTabCache(cacheKey, { category, r18, items: nextItems, hasMore: nextHasMore, page: pageRef.current }).catch(() => { });
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
    return registerRefresh('ranking', () => loadRef.current?.(false));
  }, [registerRefresh]);

  // 挂载时先尝试恢复缓存；缓存命中则跳过首次请求
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cache = await loadTabCache(cacheKey);
        if (cancelled || !cache?.items?.length) return;
        cacheUsedRef.current = true;
        if (cache.category) setCategory(cache.category);
        if (typeof cache.r18 === 'boolean') setR18(cache.r18);
        const hydratedR18 = typeof cache.r18 === 'boolean' ? cache.r18 : true;
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
  }, [cacheKey]);

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
      loadRef.current(false);
    }
    lastTokenRef.current = refreshToken;
  }, [refreshToken]);

  // 与主 TabBar 保持一致：下滑收起、上滑显示、回到顶部强制显示
  // active 守卫：四个 tab 共用 .app-content，隐藏页继续监听会被别的 tab 滚动带着收起筛选栏
  useEffect(() => {
    if (!active) return;
    const el = getMainScrollEl();
    if (!el) return;
    let last = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      if (top < 24) setShowFilters(true);
      else if (top > last + 20) setShowFilters(false);
      else if (top < last - 20) setShowFilters(true);
      last = top;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [active]);

  // 回到本 tab 时恢复筛选栏（隐藏期间可能被其他 tab 的滚动收起）
  useEffect(() => {
    if (active) setShowFilters(true);
  }, [active]);

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

  const handleCategory = (cat) => {
    // 选 R18G 时自动开 R18；选无 R18 档的分类时自动关
    if (cat === 'r18g') setR18(true);
    else if (!R18_CATEGORIES.has(cat)) setR18(false);
    setCategory(cat);
  };

  const handleR18Toggle = () => {
    if (category === 'r18g') return; // R18G 固定 R18
    if (!R18_CATEGORIES.has(category)) return; // 当前分类无 R18 档
    setR18(v => !v);
  };

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
      <div className={`chips chips-bottom${showFilters ? '' : ' chips-hidden'}`}>
        {modes.map(m => (
          <button
            key={m.key}
            className={`chip${m.key === category ? ' active' : ''}${m.label.length > 2 && m.key !== 'r18g' ? ' chip--small' : ''}`}
            onClick={() => handleCategory(m.key)}
          >{m.label}</button>
        ))}
        {!isBooru && (
          <button
            className={`chip r18-toggle${r18 ? ' on' : ''}`}
            onClick={handleR18Toggle}
            style={{ marginLeft: 'auto' }}
          >{r18 ? 'R18' : '公开'}</button>
        )}
      </div>
    </div>
  );
}

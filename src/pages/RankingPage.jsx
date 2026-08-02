import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { saveTabCache, loadTabCache } from '../pixiv-assistant/index.js';
import ImageGrid from '../components/ImageGrid.jsx';
import useSavedSet from '../hooks/useSavedSet.js';

const CACHE_KEY = 'ranking';

const MODES = [
  { key: 'daily', label: '日榜' },
  { key: 'weekly', label: '周榜' },
  { key: 'monthly', label: '月榜' },
  { key: 'male', label: '男榜' },
  { key: 'female', label: '女榜' },
  { key: 'rookie', label: '新人' },
  { key: 'original', label: '原创' },
  { key: 'r18g', label: 'R18G' },
];

// 支持 R-18 变体的分类（monthly / rookie / original 无 R18 档）
const R18_CATEGORIES = new Set(['daily', 'weekly', 'male', 'female']);

export default function RankingPage({ onOpen, likedSet, refreshToken = 0 }) {
  const [category, setCategory] = useState('daily');
  const [r18, setR18] = useState(true);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [showFilters, setShowFilters] = useState(true);
  const pageRef = useRef(1);
  const itemsRef = useRef([]);
  const sentinelRef = useRef(null);
  const [hydrated, setHydrated] = useState(false);
  const cacheUsedRef = useRef(false);
  const firstFetchDoneRef = useRef(false);
  const loadRef = useRef(null);
  const saved = useSavedSet();
  const mode = r18 && R18_CATEGORIES.has(category) ? `${category}_r18` : category;

  const load = useCallback(async (append) => {
    const page = append ? pageRef.current + 1 : 1;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const r = await pixivApi.fetchRanking({ mode, page });
      const rawList = r?.illusts || [];
      const filtered = saved?.size ? rawList.filter(img => !saved.has(`${img.illustId}_0`)) : rawList;
      pageRef.current = page;
      const nextItems = append ? [...itemsRef.current, ...filtered] : filtered;
      itemsRef.current = nextItems;
      setItems(nextItems);
      const nextHasMore = rawList.length > 0;
      setHasMore(nextHasMore);
      if (!append && !filtered.length) setError(r?.message || r?.error || '排行榜为空');
      // 持久化缓存（24h TTL）：重启 App 后直接恢复
      saveTabCache(CACHE_KEY, { category, r18, items: nextItems, hasMore: nextHasMore, page }).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
    setLoadingMore(false);
  }, [mode, category, r18]);

  loadRef.current = load;

  // 挂载时先尝试恢复缓存；缓存命中则跳过首次请求
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cache = await loadTabCache(CACHE_KEY);
        if (cancelled || !cache?.items?.length) return;
        cacheUsedRef.current = true;
          if (cache.category) setCategory(cache.category);
          if (typeof cache.r18 === 'boolean') setR18(cache.r18);
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
  }, []);

  // 切换档位（mode 变化）时重新加载；已挂载后不再重复首次请求
  useEffect(() => {
    if (!hydrated) return;
    if (!firstFetchDoneRef.current) {
      firstFetchDoneRef.current = true;
      if (cacheUsedRef.current) return; // 缓存恢复 → 跳过首次请求
    }
    load(false);
  }, [load, hydrated]);

  // 重点当前 tab → 切换筛选栏显示
  useEffect(() => {
    if (refreshToken > 0) {
      setShowFilters(v => !v);
      loadRef.current(false);
    }
  }, [refreshToken]);

  // 下滑时收起筛选栏
  useEffect(() => {
    const el = document.querySelector('.app-content');
    if (!el) return;
    let last = el.scrollTop;
    const onScroll = () => {
      if (el.scrollTop > last + 20) setShowFilters(false);
      last = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

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
      {error && <div className="error-box">{error}</div>}
      <ImageGrid items={items} savedSet={saved} likedSet={likedSet} onOpen={onOpen} />
      {!loading && hasMore && (
        <div ref={sentinelRef} style={{ height: 1 }} />
      )}
      {loadingMore && <div className="hint">加载中...</div>}
      {!loading && !hasMore && items.length > 0 && <div className="hint">没有更多了</div>}
      <div className={`chips chips-bottom bar-frosted${showFilters ? '' : ' chips-hidden'}`}>
        {MODES.map(m => (
          <button
            key={m.key}
            className={`chip${m.key === category ? ' active' : ''}`}
            onClick={() => handleCategory(m.key)}
          >{m.label}</button>
        ))}
        <button
          className={`chip r18-toggle${r18 ? ' on' : ''}`}
          onClick={handleR18Toggle}
          style={r18
            ? { background: '#e88090', color: '#fff', borderColor: '#e88090', marginLeft: 'auto' }
            : { marginLeft: 'auto' }}
        >{r18 ? 'R18' : '公开'}</button>
      </div>
    </div>
  );
}

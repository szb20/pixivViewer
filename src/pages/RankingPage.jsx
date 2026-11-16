import { useEffect, useRef } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { scopedTabKey } from '../pixiv-assistant/index.js';
import { useTabFeed } from '../hooks/useTabFeed.js';
import { useLikedSet } from '../context/pixivCacheContext.js';
import ImageGrid from '../components/ImageGrid.jsx';
import SkeletonGrid from '../components/SkeletonGrid.jsx';
import { useImageSourceId } from '../hooks/useImageSource.js';
import { booruApiFor } from '../sources/api.js';
import { getRankingModes, clampRankingCategory, R18_CATEGORIES } from '../utils/rankingModes.js';
import { useAppStore } from '../store/useAppStore.js';

const CACHE_KEY = 'ranking';
/** booru 的 popular_recent 一次返回整批，不分页 */
const BOORU_LIMIT = 60;

/**
 * RankingPage — 排行榜页（pixiv 分页 / booru 单发）。
 * useTabFeed 管缓存水合、无限滚动与刷新；页面私有的是内存档位缓存：
 * 切档位先秒开看过的内容，再紧跟一次后台刷新（见 fetchPage 的秒开分支）。
 */
export default function RankingPage({ onOpen, registerRefresh, refreshToken = 0 }) {
  const likedSet = useLikedSet();
  const sourceId = useImageSourceId();
  const booruApi = booruApiFor(sourceId);
  const isBooru = !!booruApi;
  const { modes } = getRankingModes(sourceId);
  // 档位与 R18 放在 store：侧边栏 / 抽屉的二级项驱动它
  const rawCategory = useAppStore(s => s.rankingCategory);
  const r18 = useAppStore(s => s.rankingR18);
  const setRankingSelection = useAppStore(s => s.setRankingSelection);
  // 切来源会按 key 重挂载本页，但档位留在 store 里：booru 的档位 key 与 pixiv 不通用，
  // 这里按当前来源的可用档位兜底（不写回 store，切回 pixiv 仍记得原来的档）
  const category = clampRankingCategory(modes, rawCategory);
  const mode = isBooru
    ? category
    : (r18 && R18_CATEGORIES.has(category) ? `${category}_r18` : category);

  // useTabFeed 之外的页面私有状态：内存档位缓存 + 翻页游标
  const modeCacheRef = useRef(new Map()); // mode → { items, hasMore, page }
  const loadedModeRef = useRef(null); // 当前 items 属于哪个 mode
  const pageRef = useRef(1);
  const servedCacheRef = useRef(false); // 本次 fetchPage 用内存缓存秒开，需紧跟一次后台刷新

  const feed = useTabFeed({
    cacheKey: scopedTabKey(sourceId, CACHE_KEY),
    registerRefresh,
    // 下拉刷新按 tab key 注册：store 的 triggerPullRefresh 取 refreshFns[activeTab]
    refreshKey: 'ranking',
    refreshToken,
    hydrate: (cache) => {
      if (!cache?.items?.length) return null;
      // 档位与 R18 来自同一条缓存记录，必须一次写入，避免被「选档位联动 R18」的规则改写
      setRankingSelection({ category: cache.category, r18: cache.r18 });
      const hydratedR18 = typeof cache.r18 === 'boolean' ? cache.r18 : false;
      const restoredMode = cache.mode
        || ((hydratedR18 && R18_CATEGORIES.has(cache.category)) ? `${cache.category}_r18` : (cache.category || 'daily'));
      pageRef.current = cache.page > 0 ? cache.page : 1;
      loadedModeRef.current = restoredMode;
      modeCacheRef.current.set(restoredMode, {
        items: cache.items,
        hasMore: !!cache.hasMore,
        page: pageRef.current,
      });
      return { items: cache.items, hasMore: !!cache.hasMore };
    },
    fetchPage: async (append, _currentItems, isStale) => {
      // 切档位（非首次且 mode 变化）且内存缓存命中：先秒开，
      // 随后由切档 effect 紧跟一次后台刷新拿新数据
      if (!append && loadedModeRef.current !== null && loadedModeRef.current !== mode) {
        const hit = modeCacheRef.current.get(mode);
        if (hit) {
          loadedModeRef.current = mode;
          pageRef.current = hit.page;
          servedCacheRef.current = true;
          return { list: hit.items, hasMore: !!hit.hasMore };
        }
      }

      // 非 Pixiv：popular_recent 一次给全（实测无分页参数），不做触底翻页
      if (isBooru) {
        const r = await booruApi.popular({ period: mode, limit: BOORU_LIMIT });
        if (isStale?.()) return null;
        const list = r?.illusts || [];
        const failed = !list.length && !!(r?.error || r?.message);
        loadedModeRef.current = mode;
        modeCacheRef.current.set(mode, { items: list, hasMore: false, page: 1 });
        return {
          list,
          hasMore: false,
          error: failed ? (r?.error || r?.message || '') : '',
          emptyMessage: r?.error || '排行榜为空',
          cacheExtra: { category, mode, page: 1 },
        };
      }

      const page = append ? pageRef.current + 1 : 1;
      const r = await pixivApi.fetchRanking({ mode, page });
      if (isStale?.()) return null; // 用户已切走：不推进游标，丢弃过期响应
      const list = r?.illusts || [];
      // fetchRanking 内部 catch 后返回 { illusts: [], error }，失败不能当成"没有更多了"
      const failed = !list.length && !!(r?.error || r?.message);
      if (!failed) pageRef.current = page; // 失败不推进游标，重试才会重拉同一页
      if (!append) {
        loadedModeRef.current = mode;
        modeCacheRef.current.set(mode, { items: list, hasMore: list.length > 0, page: pageRef.current });
      }
      return {
        list,
        hasMore: list.length > 0,
        error: failed ? (r?.error || r?.message || '') : '',
        emptyMessage: r?.message || r?.error || '排行榜为空',
        cacheExtra: { category, r18, page: pageRef.current },
      };
    },
  });

  // 切换档位（mode 变化）时重新加载；挂载首拉由 useTabFeed 内部负责（这里跳过第一次，
  // 水合恢复档位引发的 mode 变化也落在这一次里）
  const firstModeRunRef = useRef(true);
  const feedHydrated = feed.hydrated;
  const feedLoad = feed.load;
  useEffect(() => {
    if (!feedHydrated) return;
    if (firstModeRunRef.current) {
      firstModeRunRef.current = false;
      return;
    }
    let cancelled = false;
    servedCacheRef.current = false;
    (async () => {
      await feedLoad(false);
      // 秒开的内存缓存只是先到的结果：紧跟一次后台刷新，失败保留当前列表（keepOnFail）
      if (!cancelled && servedCacheRef.current) {
        servedCacheRef.current = false;
        feedLoad(false, { keepOnFail: true });
      }
    })();
    return () => { cancelled = true; };
  }, [mode, feedHydrated, feedLoad]);

  return (
    <div className="page">
      {feed.error && (
        <div className="error-box">
          {feed.error}
          <button className="error-retry" onClick={() => feed.load(false)}>重试</button>
        </div>
      )}
      <ImageGrid items={feed.items} likedSet={likedSet} onOpen={onOpen} />
      {feed.loading && feed.items.length === 0 && <SkeletonGrid count={12} />}
      {!feed.loading && feed.hasMore && (
        <div ref={feed.sentinelRef} style={{ height: 1 }} />
      )}
      {feed.loadingMore && <div className="feed-spinner" role="status" aria-label="加载中" />}
      {!feed.loading && feed.appendError && (
        <div className="hint hint--error" onClick={feed.retryAppend} role="button">
          加载失败，点击重试
        </div>
      )}
      {!feed.loading && !feed.appendError && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}

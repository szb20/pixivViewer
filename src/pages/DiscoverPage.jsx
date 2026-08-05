import { useMemo, useRef } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { useTabFeed } from '../hooks/useTabFeed.js';
import { useLikedSet, usePixivCache } from '../context/pixivCacheContext.js';
import ImageGrid from '../components/ImageGrid.jsx';
import { buildLikedOrSavedSet } from '../utils/worksState.js';
import NeedCookieNotice from '../components/NeedCookieNotice.jsx';
import { createLogger } from '../utils/logger.js';

const PAGE_SIZE = 20;
const CACHE_KEY = 'discover';
const log = createLogger('Discover');

export default function DiscoverPage({ onOpen, onOpenSettings, registerRefresh, refreshToken = 0 }) {
  const likedSet = useLikedSet();
  const { pixivCache } = usePixivCache();
  const startRef = useRef(0);

  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
    registerRefresh,
    refreshToken,
    // 缓存 hasMore=false（可能是不足一页的旧缓存）时不跳过网络请求，确保能继续加载
    shouldSkipFirstFetch: (applied) => !!applied.hasMore,
    hydrate: (cache) => {
      if (!cache?.items?.length) return null;
      if (cache.start > 0) startRef.current = cache.start;
      return { items: cache.items, hasMore: !!cache.hasMore };
    },
    fetchPage: async (append, currentItems) => {
      if (!append) startRef.current = 0;
      const r = await pixivApi.fetchDiscovery({ limit: PAGE_SIZE, start: startRef.current });
      const rawList = r?.illusts || [];
      log.debug('[discover-load] append:', append, 'start:', startRef.current, 'raw:', rawList.length, 'err:', r?.error || '');
      // 去重（discovery 可能重复返回同一批）
      const seen = new Set(currentItems.map(i => i.illustId));
      const filtered = rawList.filter(img => {
        return !seen.has(img.illustId);
      });
      startRef.current += rawList.length;
      return {
        list: filtered,
        // 有返回且本页有新内容才继续加载（避免 discovery 数量不足时过早停止）
        hasMore: rawList.length > 0 && filtered.length > 0,
        emptyMessage: r?.message || r?.error || '推荐为空（需要 Cookie）',
        cacheExtra: { start: startRef.current },
      };
    },
  });

  // 已喜欢/已保存的作品不再出现在推荐网格里
  const likedOrSaved = useMemo(() => buildLikedOrSavedSet(pixivCache), [pixivCache]);
  const visibleItems = useMemo(
    () => feed.items.filter(img => !likedOrSaved.has(img.illustId)),
    [feed.items, likedOrSaved],
  );

  const needCookie = !!feed.error && /cookie|no_cookie|需要.*Cookie/i.test(feed.error);

  return (
    <div className="page">
      {needCookie
        ? <NeedCookieNotice onOpenSettings={onOpenSettings} />
        : (feed.error && (
          <div className="error-box">
            {feed.error}
            <button className="error-retry" onClick={() => feed.load(false)}>重试</button>
          </div>
        ))}
      <ImageGrid items={visibleItems} likedSet={likedSet} onOpen={onOpen} />
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
      {feed.loadingMore && <div className="hint">加载中...</div>}
      {!feed.loading && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}

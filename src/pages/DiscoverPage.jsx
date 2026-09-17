import { useRef } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { useTabFeed } from '../hooks/useTabFeed.js';
import { useLikedSet, usePixivCache } from '../context/pixivCacheContext.js';
import ImageGrid from '../components/ImageGrid.jsx';
import NeedCookieNotice from '../components/NeedCookieNotice.jsx';
import { createLogger } from '../utils/logger.js';
import { hiddenWorks } from '../utils/hiddenWorks.js';

const PAGE_SIZE = 20;
const CACHE_KEY = 'discover';
const log = createLogger('Discover');

export default function DiscoverPage({ onOpen, onOpenSettings, registerRefresh, refreshToken = 0 }) {
  const likedSet = useLikedSet();
  const { recommendationExcludedSet, cacheReady } = usePixivCache();
  const startRef = useRef(0);

  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
    registerRefresh,
    refreshToken,
    // 推荐排除以启动时的收藏/保存快照为准，避免本次收藏改变当前会话的推荐流。
    enabled: cacheReady,
    // 缓存 hasMore=false（可能是不足一页的旧缓存）时不跳过网络请求，确保能继续加载
    shouldSkipFirstFetch: (applied) => !!applied.hasMore,
    hydrate: (cache) => {
      if (!cache?.items?.length) return null;
      if (cache.start > 0) startRef.current = cache.start;
      return {
        items: cache.items.filter(item => !recommendationExcludedSet?.has(String(item.illustId))),
        hasMore: !!cache.hasMore,
      };
    },
    fetchPage: async (append, currentItems) => {
      if (!append) startRef.current = 0;
      // 去重（discovery 可能重复返回同一批）
      const seen = new Set(currentItems.map(i => i.illustId));
      // 只过滤启动前已喜欢/已保存的作品。本会话新增收藏保留在后续推荐中，直到下次启动。
      const excludedAtStartup = recommendationExcludedSet || new Set();

      // 整页全被过滤（已喜欢/已保存/不想看）时继续向后拉，避免流提前中断；
      // 连续 3 页都过滤不出新内容（或上游重复返回同一批）才判定断流
      const collected = [];
      let rawTotal = 0;
      let emptyStreak = 0;
      let lastError = '';
      while (rawTotal < PAGE_SIZE * 3 && emptyStreak < 3) {
        const r = await pixivApi.fetchDiscovery({ limit: PAGE_SIZE, start: startRef.current });
        const rawList = r?.illusts || [];
        lastError = r?.message || r?.error || '';
        if (!rawList.length) break;
        rawTotal += rawList.length;
        startRef.current += rawList.length;
        let fresh = 0;
        for (const img of rawList) {
          // 跳过已显示过的 + 用户"不想看"的 + 启动前已喜欢/已保存的
          if (seen.has(img.illustId) || hiddenWorks.has(img.illustId) || excludedAtStartup.has(String(img.illustId))) continue;
          seen.add(img.illustId);
          collected.push(img);
          fresh++;
        }
        if (collected.length >= PAGE_SIZE) break;
        emptyStreak = fresh === 0 ? emptyStreak + 1 : 0;
      }
      log.debug('[discover-load] append:', append, 'start:', startRef.current, 'raw:', rawTotal, 'fresh:', collected.length, 'err:', lastError || '');
      return {
        list: collected,
        // 上游仍有返回就继续；连续多页无新内容才断流（整页被过滤不算断流）
        hasMore: rawTotal > 0 && emptyStreak < 3,
        emptyMessage: lastError || '推荐为空（需要 Cookie）',
        cacheExtra: { start: startRef.current },
      };
    },
  });

  // 注意：已喜欢/已保存的作品保留在当前网格，仅在 fetchPage 中对后续新页过滤

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
      <ImageGrid items={feed.items} likedSet={likedSet} onOpen={onOpen} layout="masonry" />
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
      {feed.loadingMore && <div className="hint">加载中...</div>}
      {!feed.loading && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}

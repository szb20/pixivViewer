import { useRef } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { useTabFeed } from '../hooks/useTabFeed.js';
import { useLikedSet, usePixivCache } from '../context/pixivCacheContext.js';
import ImageGrid from '../components/ImageGrid.jsx';
import NeedCookieNotice from '../components/NeedCookieNotice.jsx';
import { createLogger } from '../utils/logger.js';
import { hiddenWorks } from '../utils/hiddenWorks.js';
import { useImageSourceId, useBooruSafeOnly, setImageSource } from '../hooks/useImageSource.js';
import { booruApiFor } from '../sources/api.js';
import { SOURCE_LIST } from '../sources/registry.js';
import { scopedTabKey } from '../pixiv-assistant/index.js';

const PAGE_SIZE = 20;
const CACHE_KEY = 'discover';
const log = createLogger('Discover');

export default function DiscoverPage({ onOpen, onOpenSettings, registerRefresh, refreshToken = 0 }) {
  const likedSet = useLikedSet();
  const { recommendationExcludedSet, cacheReady } = usePixivCache();
  const sourceId = useImageSourceId();
  const safeOnly = useBooruSafeOnly();
  const booruApi = booruApiFor(sourceId);
  const startRef = useRef(0);
  const isBooru = !!booruApi;

  const feed = useTabFeed({
    cacheKey: scopedTabKey(sourceId, CACHE_KEY),
    registerRefresh,
    // 下拉刷新按 tab key 注册：store 的 triggerPullRefresh 取 refreshFns[activeTab]
    refreshKey: 'discover',
    refreshToken,
    // 推荐排除以启动时的收藏/保存快照为准，避免本次收藏改变当前会话的推荐流。
    // booru 来源没有这份快照，无需等待，直接放行。
    enabled: isBooru || cacheReady,
    // 缓存 hasMore=false（可能是不足一页的旧缓存）时不跳过网络请求，确保能继续加载
    shouldSkipFirstFetch: (applied) => !!applied.hasMore,
    hydrate: (cache) => {
      if (!cache?.items?.length) return null;
      if (cache.start > 0) startRef.current = cache.start;
      return {
        items: isBooru ? cache.items : cache.items.filter(item => !recommendationExcludedSet?.has(String(item.illustId))),
        hasMore: !!cache.hasMore,
      };
    },
    fetchPage: async (append, currentItems, isStale) => {
      if (!append) startRef.current = 0;

      // ── 非 Pixiv 来源：Moebooru 没有 offset 游标，翻页就是 page+1 ──
      if (isBooru) {
        const page = append ? startRef.current + 1 : 1;
        const r = await booruApi.feed({ page, limit: PAGE_SIZE, safeOnly });
        if (isStale?.()) return null;
        const list = r?.illusts || [];
        const failed = !list.length && !!(r?.message || r?.error);
        if (!failed) startRef.current = page;
        const fresh = list.filter(img => !hiddenWorks.has(img.illustId));
        return {
          list: fresh,
          hasMore: list.length > 0,
          error: failed ? (r?.message || r?.error || '') : '',
          emptyMessage: r?.message || '暂无推荐',
          cacheExtra: { start: startRef.current },
        };
      }

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
        // 响应已被刷新/新请求取代 → 立刻停手：这次 await 之后不能再推进 startRef，
        // 否则会把新一轮刷新刚归零的游标又推走一页，导致下一次触底跳过一整页
        if (isStale?.()) return null;
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
      // 整页无任何返回且有错误 → 判定为请求失败（区别于"整页被过滤"），交给 useTabFeed 提示重试
      const failed = rawTotal === 0 && !!lastError;
      return {
        list: collected,
        // 上游仍有返回就继续；连续多页无新内容才断流（整页被过滤不算断流）
        hasMore: rawTotal > 0 && emptyStreak < 3,
        error: failed ? (lastError || '推荐为空（需要 Cookie）') : '',
        emptyMessage: lastError || '推荐为空（需要 Cookie）',
        cacheExtra: { start: startRef.current },
      };
    },
  });

  // 注意：已喜欢/已保存的作品保留在当前网格，仅在 fetchPage 中对后续新页过滤

  const needCookie = !isBooru && !!feed.error && /cookie|no_cookie|需要.*Cookie/i.test(feed.error);

  return (
    <div className="page">
      {/* 来源快捷切换：与设置页共用同一状态源（模块单例），切换即全局生效 */}
      {SOURCE_LIST.length > 1 && (
        <div className="chips chips--top">
          {SOURCE_LIST.map(s => (
            <button
              key={s.id}
              className={`chip${sourceId === s.id ? ' active' : ''}`}
              onClick={() => setImageSource(s.id)}
            >{s.shortLabel || s.label}</button>
          ))}
        </div>
      )}
      {needCookie
        ? <NeedCookieNotice onOpenSettings={onOpenSettings} />
        : (feed.error && (
          <div className="error-box">
            {feed.error}
            <button className="error-retry" onClick={() => feed.load(false)}>重试</button>
          </div>
        ))}
      <ImageGrid items={feed.items} likedSet={likedSet} onOpen={onOpen} />
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
      {feed.loadingMore && <div className="hint">加载中...</div>}
      {!feed.loading && feed.appendError && (
        <div className="hint hint--error" onClick={feed.retryAppend} role="button">
          加载失败，点击重试
        </div>
      )}
      {!feed.loading && !feed.appendError && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}

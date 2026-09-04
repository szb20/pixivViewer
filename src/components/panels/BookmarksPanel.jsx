import { useEffect, useRef } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { useTabFeed } from '../../hooks/useTabFeed.js';
import { useLikedSet } from '../../context/pixivCacheContext.js';
import ImageGrid from '../ImageGrid.jsx';
import NeedCookieNotice from '../NeedCookieNotice.jsx';

const PAGE_SIZE = 48;
const CACHE_KEY = 'me_bookmarks';

/**
 * Pixiv 收藏夹面板（原 BookmarksPage 提取）。刷新注册由 MePage 聚合。
 * 只展示 pixiv 账号收藏，不再自动写入本地“喜欢”库——喜欢页只保留手动点的爱心。
 */
export default function BookmarksPanel({ onOpen, onOpenSettings, onReportLoad }) {
  const likedSet = useLikedSet();
  const offsetRef = useRef(0);

  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
    hydrate: (cache) => {
      if (!cache?.items?.length) return null;
      if (cache.offset > 0) offsetRef.current = cache.offset;
      return { items: cache.items, hasMore: !!cache.hasMore };
    },
    fetchPage: async (append) => {
      if (!append) offsetRef.current = 0;
      const r = await pixivApi.fetchBookmarks({ offset: offsetRef.current, limit: PAGE_SIZE });
      // fetchBookmarks 返回的字段是 works（收藏列表），不是 illusts
      const list = r?.works || [];
      offsetRef.current += list.length;
      return {
        list,
        hasMore: list.length >= PAGE_SIZE,
        emptyMessage: r?.message || r?.error || '收藏夹为空',
        cacheExtra: { offset: offsetRef.current },
      };
    },
  });
  const { load: reload } = feed;

  useEffect(() => {
    onReportLoad?.('bookmarks', reload);
  }, [reload, onReportLoad]);

  const needCookie = !!feed.error && /cookie|no_cookie|需要.*Cookie/i.test(feed.error);

  return (
    <>
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
    </>
  );
}

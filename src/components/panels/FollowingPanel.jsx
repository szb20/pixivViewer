import { useEffect, useRef } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { useTabFeed } from '../../hooks/useTabFeed.js';
import { useLikedSet } from '../../context/pixivCacheContext.js';
import ImageGrid from '../ImageGrid.jsx';
import NeedCookieNotice from '../NeedCookieNotice.jsx';

const PAGE_SIZE = 48;
const CACHE_KEY = 'me_following';

/** 关注画师最新作品面板（fetchFollowing 返回作品流，非用户列表）。刷新注册由 MePage 聚合。 */
export default function FollowingPanel({ onOpen, onOpenSettings, onReportLoad }) {
  const likedSet = useLikedSet();
  const pageRef = useRef(1);

  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
    hydrate: (cache) => {
      if (!cache?.items?.length) return null;
      if (cache.page > 1) pageRef.current = cache.page;
      return { items: cache.items, hasMore: !!cache.hasMore };
    },
    fetchPage: async (append) => {
      if (!append) pageRef.current = 1;
      const r = await pixivApi.fetchFollowing({ page: pageRef.current });
      const list = r?.illusts || [];
      pageRef.current += 1;
      return {
        list,
        hasMore: list.length >= PAGE_SIZE,
        emptyMessage: r?.message || r?.error || '还没有关注任何画师 — 在排行页发现喜欢的画师吧',
        cacheExtra: { page: pageRef.current },
      };
    },
  });
  const { load: reload } = feed;

  useEffect(() => {
    onReportLoad?.('following', reload);
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

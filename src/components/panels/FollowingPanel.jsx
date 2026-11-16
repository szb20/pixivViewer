import { useEffect, useRef } from 'react';
import { pixivApi, isCookieErrorCode } from '../../api/pixiv.js';
import { useTabFeed } from '../../hooks/useTabFeed.js';
import { useLikedSet } from '../../context/pixivCacheContext.js';
import ImageGrid from '../ImageGrid.jsx';

import NeedCookieNotice from '../NeedCookieNotice.jsx';

const CACHE_KEY = 'me_following';

/** 关注画师最新作品面板（fetchFollowing 返回作品流，非用户列表）。刷新注册由 SubTabPage 宿主聚合。 */
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
    fetchPage: async (append, _currentItems, isStale) => {
      if (!append) pageRef.current = 1;
      const r = await pixivApi.fetchFollowing({ page: pageRef.current });
      // 响应已被刷新/新请求取代 → 立刻停手：await 之后不能推进页码，
      // 否则会把新一轮刷新刚归零的页码又推走一页，导致触底跳页
      if (isStale?.()) return null;
      const list = r?.illusts || [];
      // 失败（有 message/error 且无数据）不推进页码，重试才会重拉同一页
      const failed = !list.length && !!(r?.message || r?.error);
      if (!failed) pageRef.current += 1;
      return {
        list,
        // fetchFollowing 是 p=1,2,3 的整页接口，上游每页容量与本地 PAGE_SIZE(48) 无关：
        // 只要有返回就继续，直到某页返回空（空页无 error → failed=false → hasMore=false 自然断流）
        hasMore: !failed && list.length > 0,
        error: failed ? (r?.message || r?.error || '') : '',
        errorCode: failed ? (r?.error || '') : '',
        emptyMessage: r?.message || r?.error || '还没有关注任何画师 — 在排行页发现喜欢的画师吧',
        cacheExtra: { page: pageRef.current },
      };
    },
  });
  const { load: reload } = feed;

  useEffect(() => {
    onReportLoad?.('following', reload);
  }, [reload, onReportLoad]);

  const needCookie = isCookieErrorCode(feed.errorCode);

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
      <ImageGrid items={feed.items} likedSet={likedSet} onOpen={onOpen} />
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
      {feed.loadingMore && <div className="feed-spinner" role="status" aria-label="加载中" />}
      {!feed.loading && feed.appendError && (
        <div className="hint hint--error" onClick={feed.retryAppend} role="button">
          加载失败，点击重试
        </div>
      )}
      {!feed.loading && !feed.appendError && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}
    </>
  );
}
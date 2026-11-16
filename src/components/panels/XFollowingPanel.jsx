import { useEffect, useRef } from 'react';
import { useTabFeed } from '../../hooks/useTabFeed.js';
import { useLikedSet } from '../../context/pixivCacheContext.js';
import { scopedTabKey } from '../../pixiv-assistant/index.js';
import { booruApiFor } from '../../sources/api.js';
import ImageGrid from '../ImageGrid.jsx';

const CACHE_KEY = 'me_following';

/**
 * X 关注时间线面板（「我」→ 关注，对齐 x.com 首页的 Following tab）。
 *
 * 数据链：配了 cookie → HomeLatestTimeline 直连（账号真实关注，按时间序）；
 * 无 cookie / 直连失败 → 自动回落 Nitter 名单聚合（nitter.js feed 内置）。
 * 与 Pixiv 的 FollowingPanel 同 key（'following'）由 SubTabPage 宿主按来源分流。
 */
export default function XFollowingPanel({ onOpen, onReportLoad }) {
  const likedSet = useLikedSet();
  const pageRef = useRef(1);

  const feed = useTabFeed({
    cacheKey: scopedTabKey('twitter', CACHE_KEY),
    fetchPage: async (append, _currentItems, isStale) => {
      if (!append) pageRef.current = 1;
      const r = await booruApiFor('twitter').feed({ page: pageRef.current, mode: 'following' });
      // 响应已被刷新/新请求取代 → 立刻停手：await 之后不能再推进页码，
      // 否则会把新一轮刷新刚归零的页码又推走一页，导致触底跳页
      if (isStale?.()) return null;
      const list = r?.illusts || [];
      // 失败（有 message/error 且无数据）不推进页码，重试才会重拉同一页
      const failed = !list.length && !!(r?.message || r?.error);
      if (!failed) pageRef.current += 1;
      return {
        list,
        // X 直连的 hasMore 来自游标链（nitter.js 透传），空页已在 xDirect 内续拉，
        // 不能只看 list.length —— 否则一页去重后为 0 就误判断流
        hasMore: !failed && (list.length > 0 || r?.hasMore === true),
        error: failed ? (r?.message || r?.error || '') : '',
        emptyMessage: r?.message || r?.error || '关注时间线还没有带图的推文 — 推荐页发现喜欢的博主，点关注即可',
        cacheExtra: { page: pageRef.current },
      };
    },
  });
  const { load: reload } = feed;

  useEffect(() => {
    onReportLoad?.('following', reload);
  }, [reload, onReportLoad]);

  return (
    <>
      {feed.error && (
        <div className="error-box">
          {feed.error}
          <button className="error-retry" onClick={() => feed.load(false)}>重试</button>
        </div>
      )}
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

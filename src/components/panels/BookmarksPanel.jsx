import { useEffect, useMemo, useRef } from 'react';
import { pixivApi, isCookieErrorCode } from '../../api/pixiv.js';
import { useTabFeed } from '../../hooks/useTabFeed.js';
import { useLikedSet, usePixivCache } from '../../context/pixivCacheContext.js';
import ImageGrid from '../ImageGrid.jsx';
import SkeletonGrid from '../SkeletonGrid.jsx';
import NeedCookieNotice from '../NeedCookieNotice.jsx';

const PAGE_SIZE = 48;
const CACHE_KEY = 'me_bookmarks';

/**
 * Pixiv 收藏夹面板（原 BookmarksPage 提取）。刷新注册由 MePage 聚合。
 * 展示 pixiv 账号收藏；列表项天然视为已收藏 → 红心全亮（显示层合并，
 * 不写本地“喜欢”库）；长按红心的远端收藏同步见 api/bookmarkSync.js。
 */
export default function BookmarksPanel({ onOpen, onOpenSettings, onReportLoad }) {
  const likedSet = useLikedSet();
  const { pixivCache } = usePixivCache();
  const offsetRef = useRef(0);

  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
    hydrate: (cache) => {
      if (!cache?.items?.length) return null;
      if (cache.offset > 0) offsetRef.current = cache.offset;
      return { items: cache.items, hasMore: !!cache.hasMore };
    },
    fetchPage: async (append, _currentItems, isStale) => {
      if (!append) offsetRef.current = 0;
      const r = await pixivApi.fetchBookmarks({ offset: offsetRef.current, limit: PAGE_SIZE });
      // 响应已被刷新/新请求取代 → 立刻停手：await 之后不能再推进游标，
      // 否则会把新一轮刷新刚归零的游标又推走一页，导致触底跳页
      if (isStale?.()) return null;
      const list = r?.illusts || [];
      // 失败（有 message/error 且无数据）不推进游标，重试才会重拉同一页
      const failed = !list.length && !!(r?.message || r?.error);
      if (!failed) offsetRef.current += list.length;
      return {
        list,
        hasMore: !failed && list.length >= PAGE_SIZE,
        error: failed ? (r?.message || r?.error || '') : '',
        errorCode: failed ? (r?.error || '') : '',
        emptyMessage: r?.message || r?.error || '收藏夹为空',
        cacheExtra: { offset: offsetRef.current },
      };
    },
  });
  const { load: reload } = feed;

  useEffect(() => {
    onReportLoad?.('bookmarks', reload);
  }, [reload, onReportLoad]);

  const needCookie = isCookieErrorCode(feed.errorCode);

  // 列表里的作品天然都是远端已收藏 → 红心全亮（显示层合并，不写全局 pixivCache）；
  // _bookmarked 供长按取消时识别「远端已收藏但本地未点」的组合态。
  // 本地明确取消过（pixivCache liked===false）的作品除外——远端收藏已移除，刷新前也立即熄灭。
  const items = useMemo(
    () => feed.items.map(it => (it._bookmarked ? it : { ...it, _bookmarked: true })),
    [feed.items]
  );
  const displayLikedSet = useMemo(() => {
    const s = new Set(likedSet);
    for (const it of items) {
      const ck = `${it.illustId}_0`;
      if (pixivCache[ck]?.liked === false) continue;
      s.add(ck);
    }
    return s;
  }, [likedSet, items, pixivCache]);

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
      <ImageGrid items={items} likedSet={displayLikedSet} onOpen={onOpen} />
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
      {feed.loadingMore && <SkeletonGrid count={6} />}
      {!feed.loading && feed.appendError && (
        <div className="hint hint--error" onClick={feed.retryAppend} role="button">
          加载失败，点击重试
        </div>
      )}
      {!feed.loading && !feed.appendError && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}
    </>
  );
}
import { useCallback, useEffect, useRef } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { useTabFeed } from '../../hooks/useTabFeed.js';
import { useLikedSet } from '../../context/pixivCacheContext.js';
import { usePixivCache } from '../../context/pixivCacheContext.js';
import { storageFacade } from '../../pixiv-assistant/index.js';
import { getCompositeKey } from '../../pixiv-assistant/core/utils.js';
import { buildLikeMeta } from '../../utils/likeMeta.js';
import { appStorage } from '../../utils/appStorage.js';
import { showToast } from '../../utils/toast.js';
import ImageGrid from '../ImageGrid.jsx';
import NeedCookieNotice from '../NeedCookieNotice.jsx';

const PAGE_SIZE = 48;
const CACHE_KEY = 'me_bookmarks';
const SYNC_DONE_KEY = 'bookmarks_like_sync_done_v1';

/** Pixiv 收藏夹面板（原 BookmarksPage 提取）。刷新注册由 MePage 聚合。 */
export default function BookmarksPanel({ onOpen, onOpenSettings, onReportLoad }) {
  const likedSet = useLikedSet();
  const { setPixivCache } = usePixivCache();
  const offsetRef = useRef(0);
  const syncStartedRef = useRef(false);

  const syncBookmarksToLikes = useCallback(async (works) => {
    const list = Array.isArray(works) ? works.filter(w => w?.illustId) : [];
    if (!list.length) return 0;
    let synced = 0;
    const updates = [];
    for (const work of list) {
      const meta = buildLikeMeta({
        ...work,
        type: work.illustType === 2 ? 'gif' : 'image',
      });
      const result = await storageFacade.like(work.illustId, 0, meta).catch(() => null);
      if (!result?.success) continue;
      synced++;
      updates.push({
        key: getCompositeKey({ illustId: work.illustId, _pageIndex: 0 }),
        likedAt: result.likedAt || Date.now(),
      });
    }
    if (updates.length > 0) {
      setPixivCache(prev => {
        const next = { ...prev };
        for (const u of updates) {
          next[u.key] = { ...next[u.key], liked: true, likedAt: u.likedAt };
        }
        return next;
      });
      window.dispatchEvent(new CustomEvent('pixiv:liked-changed'));
    }
    return synced;
  }, [setPixivCache]);

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
      await syncBookmarksToLikes(list);
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

  useEffect(() => {
    if (syncStartedRef.current) return;
    if (appStorage.get(SYNC_DONE_KEY, false)) return;
    syncStartedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        let offset = 0;
        let totalSynced = 0;
        while (!cancelled) {
          const r = await pixivApi.fetchBookmarks({ offset, limit: PAGE_SIZE });
          if (r?.error) return;
          const list = Array.isArray(r?.works) ? r.works : [];
          if (list.length === 0) break;
          totalSynced += await syncBookmarksToLikes(list);
          if (list.length < PAGE_SIZE) break;
          offset += list.length;
        }
        if (!cancelled && totalSynced > 0) {
          appStorage.set(SYNC_DONE_KEY, true);
          showToast(`已同步 ${totalSynced} 条收藏到喜欢`, { type: 'success' });
        }
      } catch {
        /* 静默失败，收藏页本身仍可正常浏览 */
      }
    })();
    return () => { cancelled = true; };
  }, [syncBookmarksToLikes]);

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
      <ImageGrid items={feed.items} likedSet={likedSet} onOpen={onOpen} />
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
      {feed.loadingMore && <div className="hint">加载中...</div>}
      {!feed.loading && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}
    </>
  );
}

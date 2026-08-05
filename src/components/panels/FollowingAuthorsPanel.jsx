import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { useTabFeed } from '../../hooks/useTabFeed.js';
import NeedCookieNotice from '../NeedCookieNotice.jsx';

const PAGE_SIZE = 30;
const WORKS_PER_AUTHOR = 12;
const MAX_CONCURRENT = 3;
const CACHE_KEY = 'me_subscriptions';

/**
 * 订阅面板 — 我关注的作者列表。
 * 每个作者一张卡片：一行作者信息（头像/名字/数字ID）+ 一行近期作品缩略图。
 */
export default function FollowingAuthorsPanel({ onOpen, onOpenAuthor, onOpenSettings, onReportLoad }) {
  const offsetRef = useRef(0);
  const [worksMap, setWorksMap] = useState({});
  const worksInFlight = useRef(new Set());
  const worksQueue = useRef([]);
  const activeCount = useRef(0);

  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
    fetchPage: async (append) => {
      if (!append) offsetRef.current = 0;
      const r = await pixivApi.fetchFollowingUsers({ offset: offsetRef.current, limit: PAGE_SIZE });
      const list = r?.users || [];
      offsetRef.current += list.length;
      const hasMore = (r?.total || 0) > offsetRef.current;
      return {
        list,
        hasMore,
        emptyMessage: r?.message || r?.error || '还没有订阅任何画师 — 在画师主页点击关注吧',
      };
    },
  });
  const { load: reload } = feed;

  const pumpQueue = useCallback(() => {
    while (activeCount.current < MAX_CONCURRENT && worksQueue.current.length) {
      const userId = worksQueue.current.shift();
      if (worksInFlight.current.has(userId)) continue;
      worksInFlight.current.add(userId);
      activeCount.current++;
      pixivApi.fetchUserIllusts(userId, { limit: WORKS_PER_AUTHOR })
        .then((r) => {
          if (r?.illusts?.length) {
            setWorksMap(prev => (prev[userId] ? prev : { ...prev, [userId]: r.illusts }));
          }
        })
        .catch(() => {})
        .finally(() => {
          worksInFlight.current.delete(userId);
          activeCount.current--;
          pumpQueue();
        });
    }
  }, []);

  // 作者列表就绪后，把未加载的作者入队并启动有限并发拉取近期作品
  useEffect(() => {
    for (const u of feed.items || []) {
      const id = String(u.userId);
      if (!worksMap[id] && !worksInFlight.current.has(id) && !worksQueue.current.includes(id)) {
        worksQueue.current.push(id);
      }
    }
    pumpQueue();
  }, [feed.items, worksMap, pumpQueue]);

  useEffect(() => {
    onReportLoad?.('subscriptions', reload);
  }, [reload, onReportLoad]);

  const needCookie = !!feed.error && /cookie|no_cookie|需要.*Cookie/i.test(feed.error);

  const openWork = useCallback((w) => {
    onOpen?.({
      illustId: w.illustId,
      _pageIndex: 0,
      _totalPages: w.pageCount || 1,
      type: w.type === 'gif' ? 'gif' : 'image',
      title: w.title,
      author: w.authorName || w.author,
      authorId: w.authorId,
      thumbnailUrl: w.thumbnailUrl,
    });
  }, [onOpen]);

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
      {!feed.loading && !feed.error && feed.items.length === 0 && (
        <div className="error-box">还没有订阅任何画师 — 在画师主页点击关注吧</div>
      )}
      <div className="author-list">
        {feed.items.map(u => (
          <div key={u.userId} className="author-card">
            <button
              className="author-card-head"
              onClick={() => onOpenAuthor?.(u.userId, u.name, u.avatar)}
            >
              {u.avatar
                ? <img className="author-avatar" src={u.avatar} alt="" loading="lazy" />
                : <span className="author-avatar author-avatar--fallback">{u.name?.[0] || '?'}</span>}
              <span className="author-meta">
                <span className="author-name">{u.name}</span>
                <span className="author-account">ID: {u.userId}</span>
              </span>
              <span className="author-chevron">›</span>
            </button>
            <div className="author-card-works">
              {(worksMap[u.userId] || []).map(w => (
                <button key={w.illustId} className="author-work" onClick={() => openWork(w)}>
                  <img
                    className="author-work-thumb"
                    src={w.thumbnailUrl || w.mediumUrl}
                    alt={w.title || ''}
                    loading="lazy"
                  />
                </button>
              ))}
              {!worksMap[u.userId] && [...Array(WORKS_PER_AUTHOR)].map((_, i) => (
                <span key={i} className="author-work author-work--skeleton" />
              ))}
            </div>
          </div>
        ))}
      </div>
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
    </>
  );
}

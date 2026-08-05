import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { registerBackHandler } from '../utils/backHandler.js';
import { gridThumbUrl } from '../utils/quality.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AuthorWorks');
/** 每次滑到底加载的作品数（并发取详情） */
const BATCH_SIZE = 12;

/**
 * 全屏"作者作品"页 — 网格展示某画师的作品，点击可打开详情。
 * 首屏用 profile/top（带元数据），滑到底再用 profile/all 的全部 ID 分批取详情（无限滚动）。
 * 叠加在详情页之上，系统返回键先关闭本页。
 */
export default function AuthorWorksPage({ authorId, authorName, onClose, onOpenImage }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const pendingIdsRef = useRef([]);
  const sentinelRef = useRef(null);

  // 系统返回手势/返回键：先关本页
  useEffect(() => {
    return registerBackHandler(() => {
      onClose();
      return true;
    });
  }, [onClose]);

  // 首次加载：首屏 profile/top 元数据 + profile/all 全部 ID（剩余留给无限滚动）
  useEffect(() => {
    if (!authorId) {
      setLoading(false);
      setError('缺少作者 ID');
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [top, all] = await Promise.all([
          pixivApi.fetchUserIllusts(authorId, { limit: 200 }),
          pixivApi.fetchUserIllustIds(authorId),
        ]);
        if (cancelled) return;
        const first = top?.illusts || [];
        const allIds = all?.illustIds || [];
        const topIds = new Set(first.map(i => i.illustId));
        pendingIdsRef.current = allIds.filter(id => !topIds.has(id));
        setItems(first);
        setHasMore(pendingIdsRef.current.length > 0);
        if (!first.length && !allIds.length) setError('该作者暂无作品');
      } catch (e) {
        if (cancelled) return;
        log.warn('作者作品加载失败:', e?.message || e);
        setError('加载失败，请重试');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [authorId]);

  // 加载下一页：从剩余 ID 中取一批，并发拉详情
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    const ids = pendingIdsRef.current;
    if (!ids.length) { setHasMore(false); return; }
    const batch = ids.splice(0, BATCH_SIZE);
    setLoadingMore(true);
    try {
      const results = await Promise.allSettled(batch.map(id => pixivApi.fetchIllust(id)));
      const newItems = [];
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const illust = r.value?.illust;
        if (!illust?.illustId) continue;
        const p0 = illust.images?.[0] || {};
        newItems.push({
          illustId: String(illust.illustId),
          title: illust.title || '',
          author: illust.authorName || '',
          authorName: illust.authorName || '',
          authorAccount: illust.authorAccount || '',
          authorId: String(authorId),
          thumbnailUrl: p0.thumbnailUrl || p0.previewUrl || p0.url || '',
          mediumUrl: p0.previewUrl || p0.url || '',
          originalUrl: p0.originalUrl || p0.url || '',
          pageCount: illust.pageCount || 1,
          illustType: illust.illustType ?? 0,
          type: illust.illustType === 2 ? 'gif' : 'image',
          tags: illust.tags || [],
          pixivUrl: illust.pixivUrl || '',
        });
      }
      setItems(prev => [...prev, ...newItems]);
      setHasMore(pendingIdsRef.current.length > 0);
    } catch (e) {
      log.warn('加载更多失败:', e?.message || e);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, authorId]);

  // 哨兵触底自动加载
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loadingMore) loadMore();
    }, { rootMargin: '300px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadingMore, loadMore]);

  const handleOpen = useCallback((it) => onOpenImage?.(it), [onOpenImage]);

  return (
    <div className="author-works-overlay">
      <div className="author-works-content">
        <div className="author-works-header">
          <button className="author-works-back" onClick={onClose} aria-label="返回">‹</button>
          <span className="author-works-title">@{authorName || authorId} 的作品</span>
        </div>
        {loading && <div className="hint">加载中...</div>}
        {error && <div className="error-box">{error}</div>}
        {!loading && !error && (
          <div className="pixiv-grid">
            {items.map(it => (
              <div key={it.illustId} className="pixiv-grid-item" onClick={() => handleOpen(it)}>
                <div className="media-card-thumb-wrap">
                  <img
                    className="media-card-thumb"
                    src={gridThumbUrl(it.thumbnailUrl)}
                    alt={it.title || it.illustId}
                    loading="lazy"
                    onError={e => { e.target.style.display = 'none'; }}
                  />
                  {Number(it.pageCount) > 1 && (
                    <span className="pixiv-grid-pages frosted">
                      {Number(it.pageCount)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
        {loadingMore && <div className="hint">加载中...</div>}
        {!loading && !hasMore && items.length > 0 && <div className="hint">没有更多了</div>}
      </div>
    </div>
  );
}

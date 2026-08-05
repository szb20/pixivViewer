import { useEffect, useRef, useState } from 'react';
import { storageFacade } from '../pixiv-assistant/index.js';
import { pixivApi } from '../api/pixiv.js';
import { useTabFeed } from '../hooks/useTabFeed.js';
import { pixivReUrl } from '../pixiv-assistant/core/utils.js';
import { createLogger } from '../utils/logger.js';

const PAGE_SIZE = 24;
const CACHE_KEY = 'gallery';
const log = createLogger('GalleryPage');
// 模块级去重：缺缩略图的老记录只迁移一次，失败的本次会话不再重试
const migrateInFlight = new Set();
const migrateFailed = new Set();

export default function GalleryPage({ onOpen, registerRefresh }) {
  const offsetRef = useRef(0);
  // 加载失败的缩略图 key 集合 → 显示占位，点击重试
  const [failed, setFailed] = useState({});

  // 本地数据源（IndexedDB 喜欢列表），分页 + 哨兵 + 刷新统一由 useTabFeed 处理
  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
    registerRefresh,
    fetchPage: async (append) => {
      if (!append) offsetRef.current = 0;
      const r = await storageFacade.listLiked(offsetRef.current, PAGE_SIZE);
      const list = r?.items || [];
      offsetRef.current += list.length;
      const hasMore = (r?.total || 0) > offsetRef.current;
      // 网格直接显示 250px 缩略图，不加载本地原图（避免大图刷屏）
      return { list, hasMore };
    },
  });
  const { load: reload } = feed;

  // 老记录没存缩略图：后台拉一次详情回填（一次性迁移），避免网格加载 pixiv.re 原图
  useEffect(() => {
    const missing = feed.items.filter(it =>
      !it.thumbnailUrl && !migrateInFlight.has(it.illustId) && !migrateFailed.has(it.illustId));
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      let updated = 0;
      for (const it of missing.slice(0, 4)) {
        if (cancelled) return;
        migrateInFlight.add(it.illustId);
        try {
          const r = await pixivApi.fetchIllust(it.illustId);
          if (cancelled || !r?.illust) { migrateFailed.add(it.illustId); continue; }
          const p0 = r.illust.images?.[0] || {};
          const res = await storageFacade.backfillMeta(it.illustId, it.pageIndex ?? 0, {
            thumbnailUrl: p0.thumbnailUrl || p0.previewUrl || p0.url || '',
            title: r.illust.title || '',
            authorName: r.illust.authorName || r.illust.author || '',
            authorId: r.illust.authorId || '',
            pageCount: r.illust.pageCount || 0,
          });
          if (res?.updated) updated += 1;
          else migrateFailed.add(it.illustId);
        } catch (e) {
          migrateFailed.add(it.illustId);
          log.warn('回填喜欢页缩略图失败:', it.illustId, e?.message || e);
        } finally {
          migrateInFlight.delete(it.illustId);
        }
      }
      if (!cancelled && updated > 0) reload(false);
    })();
    return () => { cancelled = true; };
  }, [feed.items, reload]);

  // 喜欢状态变化（详情页点❤️/取消）→ 刷新列表
  useEffect(() => {
    const onLikedChanged = () => reload(false);
    window.addEventListener('pixiv:liked-changed', onLikedChanged);
    return () => window.removeEventListener('pixiv:liked-changed', onLikedChanged);
  }, [reload]);

  return (
    <div className="page">
      {feed.loading && feed.items.length === 0 && <div className="hint">加载中...</div>}
      {!feed.loading && feed.error && (
        <div className="error-box">
          {feed.error}
          <button className="error-retry" onClick={() => feed.load(false)}>重试</button>
        </div>
      )}
      {!feed.loading && !feed.error && feed.items.length === 0 && (
        <div className="error-box">还没有喜欢的作品 — 在详情页点击爱心即可收藏</div>
      )}
      <div className="gallery-grid">
        {feed.items.map(item => {
          const id = `${item.illustId}_${item.pageIndex ?? 0}`;
          // 优先用点赞时存的 API 缩略图；缺失时显示占位块，由后台迁移回填，不再加载原图
          const src = item.thumbnailUrl || '';
          return (
            <div key={id} className="gallery-item"
              onClick={() => onOpen?.({
                illustId: item.illustId,
                _pageIndex: item.pageIndex ?? 0,
                _totalPages: item.pageCount || item.frameCount || 1,
                type: item.isGif ? 'gif' : 'image',
                title: item.title,
                author: item.author,
                authorId: item.authorId,
                authorName: item.authorName,
                thumbnailUrl: item.thumbnailUrl || pixivReUrl(String(item.illustId), 0),
              })}
            >
              {src ? (
                failed[id] ? (
                  <div className="gallery-thumb-fallback" onClick={e => { e.stopPropagation(); setFailed(p => ({ ...p, [id]: false })); }}>
                    加载失败<br />点此重试
                  </div>
                ) : (
                  <img className="gallery-thumb" src={src} alt={item.title || ''} loading="lazy"
                    onError={() => setFailed(p => ({ ...p, [id]: true }))} />
                )
              ) : (
                <div className="gallery-thumb" />
              )}
            </div>
          );
        })}
      </div>
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
    </div>
  );
}

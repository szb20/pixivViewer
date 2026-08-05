import { useEffect, useRef } from 'react';
import { storageFacade } from '../../pixiv-assistant/index.js';
import { pixivApi } from '../../api/pixiv.js';
import { useTabFeed } from '../../hooks/useTabFeed.js';
import { pixivReUrl } from '../../pixiv-assistant/core/utils.js';
import { createLogger } from '../../utils/logger.js';
import GridItem from '../../components/GridItem.jsx';

const PAGE_SIZE = 24;
const CACHE_KEY = 'me_liked';
const log = createLogger('LikedPanel');
// 模块级去重：缺缩略图的老记录只迁移一次，失败的本次会话不再重试
const migrateInFlight = new Set();
const migrateFailed = new Set();

/** 本地喜欢面板（原 GalleryPage 提取）。刷新注册由 MePage 聚合，不在此注册。 */
export default function LikedPanel({ onOpen, onReportLoad }) {
  const offsetRef = useRef(0);

  // 本地数据源（IndexedDB 喜欢列表），分页 + 哨兵由 useTabFeed 处理
  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
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

  // 上报 load 给 MePage，用于"我"页下拉刷新 / 双击刷新
  useEffect(() => {
    onReportLoad?.('liked', reload);
  }, [reload, onReportLoad]);

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
    <>
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
        {feed.items.map(item => (
          <GridItem
            key={`${item.illustId}_${item.pageIndex ?? 0}`}
            img={item}
            isLiked
            onOpen={(it) => onOpen?.({
              illustId: it.illustId,
              _pageIndex: it.pageIndex ?? 0,
              _totalPages: it.pageCount || it.frameCount || 1,
              type: it.isGif ? 'gif' : 'image',
              title: it.title,
              author: it.author,
              authorId: it.authorId,
              authorName: it.authorName,
              authorAvatar: it.authorAvatar || '',
              thumbnailUrl: it.thumbnailUrl || pixivReUrl(String(it.illustId), 0),
            })}
            variant="gallery"
          />
        ))}
      </div>
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
    </>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { saveItem } from '../../api/index.js';
import { pixivReUrl } from '../../pixiv-assistant/core/utils.js';
import { getCompositeKey } from '../../pixiv-assistant/core/utils.js';
import { LikeButton } from '../LightboxActions.jsx';
import MediaLightbox from '../MediaLightbox.jsx';
import UgoiraPlayer from '../UgoiraPlayer.jsx';
import { usePixivCache } from '../../context/pixivCacheContext.js';
import { parsePixivResults, allMediaFromRelated } from './helpers.js';
import { getSettingsSync } from '../../pixiv-assistant/index.js';
import { gridThumbUrl } from '../../utils/quality.js';
import { registerBackHandler } from '../../utils/backHandler.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ImageDetail');
/** 批量保存时的最大并发页数 */
const SAVE_BATCH_SIZE = 3;

/**
 * 多图详情页的单页块 — 所有页面上下堆叠展示。
 * 进入视口时懒加载原图（本地相册优先 → 网络原图），
 * 原图就绪前用缩略图模糊铺底；点击打开灯箱。
 */
function DetailPageBlock({ page, image, previewUrl, defaultRatio, registerRef, onOpenLightbox }) {
  const wrapRef = useRef(null);
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(null); // 预览图加载后按真实比例覆盖占位

  // 第 0 页：方形缩略图作模糊铺底（加载过渡用）
  const bg = page === 0
    ? (image?.thumbnailUrl || pixivReUrl(String(image.illustId), 0, 'thumb'))
    : '';
  // 展示图：540px 等比预览（加载前只保留比例占位块）
  const src = previewUrl;
  const heroRatio = ratio || defaultRatio || '3 / 4';

  return (
    <div
      ref={(node) => { wrapRef.current = node; registerRef?.(page, node); }}
      className="image-detail-hero"
      style={{ aspectRatio: heroRatio }}
      onClick={() => onOpenLightbox?.(page)}
    >
      {bg && <img className="image-detail-bg" src={bg} alt="" />}
      {src && !failed ? (
        <img
          className="image-detail-main image-detail-main--flow"
          key={src}
          src={src}
          alt={`第 ${page + 1} 页`}
          loading="lazy"
          onLoad={(e) => {
            // 仅等比预览图参与宽高比校准，方形缩略图不参与
            if (previewUrl) {
              const nw = e.currentTarget.naturalWidth;
              const nh = e.currentTarget.naturalHeight;
              if (nw && nh) setRatio(`${nw} / ${nh}`);
            }
          }}
          onError={() => {
            log.warn('详情页预览图加载失败:', page, src?.slice(0, 120));
            setFailed(true);
          }}
        />
      ) : (src && failed ? (
        <div className="image-detail-error">加载失败</div>
      ) : null)}
    </div>
  );
}

/**
 * 图片详情页 — 全屏展示大图 + 信息 + 操作 + 相关推荐网格。
 * 点击图片进入，往下滑看推荐，点推荐图片切换详情。
 */
export default function ImageDetailView({
  image, onSelectImage, onAuthorWorks, onSearchTag,
  restoreScroll = 0,
}) {
  const { pixivCache, setPixivCache } = usePixivCache();
  const [related, setRelated] = useState([]);
  const [loadingRelated, setLoadingRelated] = useState(false);
  const relatedCacheRef = useRef({}); // illustId → { related, loadedPages }
  const [lightboxIndex, setLightboxIndex] = useState(null); // 灯箱：点击大图打开全屏预览
  const [illustData, setIllustData] = useState(null);
  const contentRef = useRef(null);
  const relatedRef = useRef(null); // 相关推荐哨兵
  const pageRefs = useRef({}); // page → DOM 节点（跳转 / 视口定位）
  const [showFloatingLike, setShowFloatingLike] = useState(true);

  // 兼容旧数据：列表接口映射可能只带 illustType 不带 type
  const isGif = image?.type === 'gif' || Number(image?.illustType) === 2;
  // Tag 展示：直接用列表返回的 tag（详情 API 额外 tag 不做增量追加）
  const tags = (image?.tags || []).slice(0, 12);
  const pageCount = Math.max(
    illustData?.illust?.pageCount || 0,
    illustData?.illust?.images?.length || 0,
    image?._totalPages || 0,
    1,
  );
  // 详情页占位宽高比：优先第 0 页真实尺寸，拿不到用常见 3:4 兜底
  const defaultRatio = (() => {
    const w = image?.width || illustData?.illust?.width || 0;
    const h = image?.height || illustData?.illust?.height || 0;
    return w && h ? `${w} / ${h}` : '3 / 4';
  })();

  // 切换作品时重置详情数据（避免残留上一张作品的画面）
  useEffect(() => {
    setIllustData(null);
    setLightboxIndex(null);
  }, [image?.illustId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 切换作品时滚回顶部（或恢复之前滚动位置），指定非首页时滚动到对应页
  useEffect(() => {
    if (!image?.illustId) return;
    const target = image?._pageIndex ?? 0;
    const t = setTimeout(() => {
      if (target > 0) {
        const node = pageRefs.current[target];
        if (node) { node.scrollIntoView({ block: 'start' }); return; }
      }
      log.info('scrollTo:', restoreScroll, 'target:', target, 'illustId:', image?.illustId);
      contentRef.current?.scrollTo({ top: restoreScroll || 0, behavior: 'instant' });
    }, 100);
    return () => clearTimeout(t);
  }, [image?.illustId, image?._pageIndex, restoreScroll]);

  // 获取作品详情（所有页共享同一份 API 响应，仅依赖 illustId，不随翻页重复请求）
  useEffect(() => {
    if (!image?.illustId) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await pixivApi.fetchIllust(image.illustId);
        if (!cancelled) setIllustData(result);
      } catch (e) {
        // fetchIllust 失败 → illustData 保持 null，后续按页从 URL 推导
        log.warn('fetchIllust 失败:', image.illustId, e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, [image?.illustId]);

  // 构造保存条目（单页）— 缺详情 URL 时用 illustId 推导 pixiv.re 直链兜底
  const buildSaveItem = useCallback((page) => {
    const pg = illustData?.illust?.images?.[page] || {};
    const derived = image?.illustId ? pixivReUrl(String(image.illustId), page) : '';
    return {
      illustId: image.illustId,
      _pageIndex: page,
      _silent: true, // 自动/批量保存不弹 toast
      type: isGif ? 'gif' : 'image',
      originalUrl: pg.originalUrl || (page === 0 ? image.originalUrl : '') || derived || '',
      mediumUrl: pg.url || (page === 0 ? image.mediumUrl : '') || derived || '',
      thumbnailUrl: image.thumbnailUrl,
      title: image.title,
      author: image.author,
      authorName: image.authorName,
    };
  }, [image, illustData, isGif]);

  // 保存全部页（长按❤️/喜欢单图时调用）— 分批并发，最多 3 页同时下载；返回实际保存页数
  const saveAllPages = useCallback(async () => {
    if (!image?.illustId) return 0;
    let imgs = illustData?.illust?.images || [];
    let total = pageCount;
    // illustData 未就绪时先拉一次详情，确保拿到完整页数
    if (imgs.length === 0) {
      try {
        const r = await pixivApi.fetchIllust(image.illustId);
        imgs = r?.illust?.images || [];
        total = Math.max(r?.illust?.pageCount || 0, imgs.length || 0);
      } catch (e) { log.debug('补拉详情失败，保持当前页数:', e?.message || e); }
    }
    total = Math.max(total, image?._totalPages || 1);
    const pages = [];
    for (let p = 0; p < total; p++) {
      // 跳过已保存的页面（auto-save 已处理当前页，避免重复下载+重复 toast）
      const ck = getCompositeKey({ illustId: image.illustId, _pageIndex: p });
      if (pixivCache[ck]?.saved) continue;
      pages.push({ item: buildSaveItem(p), ck });
    }
    let savedCount = 0;
    for (let i = 0; i < pages.length; i += SAVE_BATCH_SIZE) {
      const batch = pages.slice(i, i + SAVE_BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async ({ item, ck }) => {
        const r = await saveItem(item);
        if (r?.success || r?.cached) {
          setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], cached: true, saved: true } }));
          return 1;
        }
        return 0;
      }));
      for (const r of results) {
        if (r.status === 'fulfilled') savedCount += r.value;
        else log.warn('批量保存单页失败:', r.reason?.message || r.reason);
      }
    }
    return savedCount;
  }, [image, pageCount, illustData, pixivCache, buildSaveItem, setPixivCache]);

  // 灯箱媒体项：点击大图弹出全屏预览（按 detailQuality 加载原图档）。
  // 滚动视图只显示最小等比预览图，原图在灯箱按需加载。
  const lightboxMedia = (() => {
    if (!image?.illustId) return [];
    const totalPages = Math.max(pageCount, image?._totalPages || 1);
    const items = [];
    const imgs = illustData?.illust?.images || [];
    const useRegular = getSettingsSync().detailQuality === 'regular';
    for (let p = 0; p < totalPages; p++) {
      let src = (useRegular ? imgs[p]?.url : imgs[p]?.originalUrl) || imgs[p]?.url || imgs[p]?.originalUrl;
      if (!src) {
        const p0 = imgs[0]?.url || imgs[0]?.originalUrl || '';
        src = p0 ? p0.replace(/_p0\./, `_p${p}.`).replace(/_p0_/, `_p${p}_`) : '';
      }
      items.push({
        type: isGif ? 'gif' : 'image',
        src,
        illustId: image.illustId,
        _pageIndex: p,
        _totalPages: totalPages,
        _lazy: isGif ? true : undefined,
        title: image?.title || '',
        author: image?.author || '',
        authorId: image?.authorId || '',
        authorName: image?.authorName || image?.author || '',
        pixivUrl: image?.pixivUrl || `https://www.pixiv.net/artworks/${image.illustId}`,
        width: image?.width || 0,
        height: image?.height || 0,
        thumbnailUrl: image?.thumbnailUrl || pixivReUrl(String(image.illustId), 0, 'thumb'),
      });
    }
    return items;
  })();

  // 灯箱打开时注册返回处理（关闭灯箱，不回退到详情栈）
  useEffect(() => {
    if (lightboxIndex === null) return;
    return registerBackHandler(() => {
      setLightboxIndex(null);
      return true;
    });
  }, [lightboxIndex]);

  // 下滑超过 300px 隐藏悬浮爱心
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const onScroll = () => setShowFloatingLike(el.scrollTop < 300);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 加载相关推荐（优先缓存）
  useEffect(() => {
    if (!image?.illustId) return;
    const cached = relatedCacheRef.current[image.illustId];
    if (cached) {
      setRelated(cached.related);
      setLoadingRelated(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setRelated([]);
      setLoadingRelated(true);
      try {
        const result = await pixivApi.fetchRelated(image.illustId, { limit: 30 });
        if (cancelled) return;
        const rawList = result?.illusts || [];
        const parsed = rawList.length > 0 ? parsePixivResults(rawList) : [];
        setRelated(parsed);
        relatedCacheRef.current[image.illustId] = { related: parsed };
      } catch (e) {
        if (cancelled) return;
        log.warn('fetchRelated failed:', e);
      }
      if (!cancelled) setLoadingRelated(false);
    })();
    return () => { cancelled = true; };
  }, [image?.illustId]);

  return (
    <div className="char-state-bar">
      <div className="char-state-content" ref={contentRef}>
        {/* GIF 动图：用动图播放器 */}
        {isGif ? (
          <div style={{ display: 'flex', justifyContent: 'center' }} onClick={() => setLightboxIndex(0)}>
            <UgoiraPlayer
              key={image?.illustId}
              illustId={image?.illustId}
              thumbnailUrl={image?.thumbnailUrl}
              hideInfo
              _lazy
              clickable={false}
            />
          </div>
        ) : (
          <>
            {/* 全部页面上下堆叠：滚动视图显示最小等比预览图（master360），原图在灯箱按需加载 */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {Array.from({ length: pageCount }, (_, p) => (
                <DetailPageBlock
                  key={`${image.illustId}-${p}`}
                  page={p}
                  image={image}
                  previewUrl={illustData?.illust?.images?.[p]?.previewUrl || illustData?.illust?.images?.[p]?.url || ''}
                  defaultRatio={defaultRatio}
                  registerRef={(page, node) => { pageRefs.current[page] = node; }}
                  onOpenLightbox={(page) => setLightboxIndex(page)}
                />
              ))}
            </div>
          </>
        )}

        {/* 标题 + 作者 */}
        <div className="image-detail-meta">
          <h2 className="image-detail-title">{image?.title || '未命名'}</h2>
          <div className="image-detail-author-row">
            {image?.authorName || image?.author ? (
              <span className="image-detail-author"
                onClick={() => onAuthorWorks?.(image.authorId, image.authorName || image.author)}>
                @{image.authorName || image.author}
              </span>
            ) : null}
            <a className="image-detail-pixiv-link"
              href={image?.pixivUrl || `https://www.pixiv.net/artworks/${image.illustId}`}
              target="_blank" rel="noreferrer"
              onClick={e => e.stopPropagation()}>
              Pixiv
            </a>
          </div>
        </div>

        {/* Tag 展示栏：点击跳搜索 */}
        {tags.length > 0 && (
          <div className="image-detail-tags">
            {tags.map(tag => (
              <button
                key={tag}
                className="image-detail-tag"
                onClick={() => onSearchTag?.(tag)}
              >{tag}</button>
            ))}
          </div>
        )}

        {/* 相关推荐网格 */}
        <div style={{ height: 60 }} />
        {loadingRelated && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 0 }}>
            {[1,2,3,4,5,6].map(i => (
              <div key={i} style={{ aspectRatio: '1', background: 'var(--bg-secondary)' }} />
            ))}
          </div>
        )}
        {related.length > 0 && (
          <div className="pixiv-grid" ref={relatedRef}>
            {related.map((img, i) => {
              if (img._pageIndex !== 0) return null;
              if (related.findIndex(mi => mi.illustId === img.illustId && mi._pageIndex === 0) !== i) return null;
              const isGif = img.type === 'gif';
              const target = allMediaFromRelated(img);
              return (
                <div key={`rel-${img.illustId}`}
                  className="pixiv-grid-item"
                  onClick={() => onSelectImage?.(target)}
                >
                  <div className="media-card-thumb-wrap">
                    <img className="media-card-thumb"
                      src={gridThumbUrl(img.thumbnailUrl || img.mediumUrl)}
                      alt={img.title}
                      loading="lazy"
                      onError={e => { e.target.style.display = 'none'; }}
                    />
                    {isGif && (
                      <div className="gif-play-overlay">
                        <span className="gif-play-icon">▶</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 底部间距 */}
        <div style={{ height: 24 }} />
      </div>

      {/* 灯箱 — 点击大图弹出全屏预览（缩放/手势） */}
      {lightboxIndex !== null && (
        <MediaLightbox
          items={lightboxMedia}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={(idx) => setLightboxIndex(idx)}
          zIndex={10000}
        />
      )}

      {/* 喜欢按钮 — 左下角悬浮，滑到相关推荐后隐藏 */}
      {showFloatingLike && (
        <div className="detail-floating-like">
          <LikeButton
            cur={image}
            onLikeSaveAll={saveAllPages}
            totalPages={pageCount}
          />
        </div>
      )}
    </div>
  );
}

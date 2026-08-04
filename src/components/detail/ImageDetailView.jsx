import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { saveItem } from '../../api/index.js';
import { pixivReUrl } from '../../pixiv-assistant/core/utils.js';
import { getCompositeKey } from '../../pixiv-assistant/core/utils.js';
import { LikeButton } from '../LightboxActions.jsx';
import MediaLightbox from '../MediaLightbox.jsx';
import UgoiraPlayer from '../UgoiraPlayer.jsx';
import { usePixivCache } from '../../context/pixivCacheContext.js';
import { parsePixivResults, allMediaFromRelated } from './helpers.js';
import { getSettingsSync, storageFacade } from '../../pixiv-assistant/index.js';
import { gridThumbUrl } from '../../utils/quality.js';
import { registerBackHandler } from '../../utils/backHandler.js';
import { createLogger } from '../../utils/logger.js';
import { showToast } from '../../utils/toast.js';

const log = createLogger('ImageDetail');
/** 批量保存时的最大并发页数 */
const SAVE_BATCH_SIZE = 3;

/**
 * 多图详情页的单页块 — 所有页面上下堆叠展示。
 * 进入视口时懒加载原图（本地相册优先 → 网络原图），
 * 原图就绪前用缩略图模糊铺底；点击打开灯箱；长按下载该页原图。
 */
function DetailPageBlock({ page, totalPages, image, previewUrl, defaultRatio, registerRef, onOpenLightbox, onLongPress }) {
  const wrapRef = useRef(null);
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(null); // 预览图加载后按真实比例覆盖占位
  const [loaded, setLoaded] = useState(false); // 预览图是否加载完成（加载占位用）
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const startPosRef = useRef(null); // 长按起始位置（用于移动阈值判断）

  // 长按 500ms 触发单页下载；只有明显移动(>10px)/抬起/离开才取消。
  // 注意：不监听 pointercancel 取消 —— WebView 自己的长按检测会先发 pointercancel，
  // 若取消会把手势吃掉（这也是之前长按失效的原因）。
  const startLongPress = useCallback((e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressTriggeredRef.current = false;
    clearTimeout(longPressTimerRef.current);
    startPosRef.current = { x: e.clientX, y: e.clientY };
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      onLongPress?.(page);
    }, 500);
  }, [page, onLongPress]);
  const handleLongPressMove = useCallback((e) => {
    const start = startPosRef.current;
    if (start && (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10)) {
      clearTimeout(longPressTimerRef.current);
      startPosRef.current = null;
    }
  }, []);
  const cancelLongPress = useCallback(() => {
    clearTimeout(longPressTimerRef.current);
    startPosRef.current = null;
  }, []);

  // 所有页用缩略图模糊铺底，第 0 页用 thumb，其他页更模糊
  const bg = image?.thumbnailUrl || pixivReUrl(String(image.illustId), page, 'thumb');
  const bgClass = page === 0 ? 'image-detail-bg' : 'image-detail-bg image-detail-bg--deep';
  // 展示图：已下载页 → 本地原图（blob）；未下载页 → 540px 等比预览（加载前只保留比例占位块）
  const src = previewUrl;
  const heroRatio = ratio || defaultRatio || '3 / 4';

  return (
    <div
      ref={(node) => { wrapRef.current = node; registerRef?.(page, node); }}
      className="image-detail-hero"
      onClick={() => {
        if (longPressTriggeredRef.current) {
          longPressTriggeredRef.current = false;
          return;
        }
        onOpenLightbox?.(page);
      }}
      onPointerDown={startLongPress}
      onPointerMove={handleLongPressMove}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onContextMenu={(e) => e.preventDefault()}
      style={{ aspectRatio: heroRatio, WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'pan-y' }}
    >
      {bg && <img className={bgClass} src={bg} alt="" />}
      {src && !failed ? (
        <>
          {!loaded && (
            <div className="image-detail-placeholder">
              <span className="image-detail-placeholder-spinner" />
            </div>
          )}
          <img
            className="image-detail-main image-detail-main--flow"
            key={src}
            src={src}
            alt={`第 ${page + 1} 页`}
            loading="lazy"
            draggable={false}
            onLoad={(e) => {
              setLoaded(true);
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
        </>
      ) : (src && failed ? (
        <div className="image-detail-error">加载失败</div>
      ) : null)}
      {/* 页数标注：直接标在本页图片右下角 */}
      {totalPages > 1 && (
        <span className="detail-hero-pages">{page + 1} / {totalPages}</span>
      )}
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
  const relatedInViewRef = useRef(false); // 相关推荐是否在视口内
  const pageRefs = useRef({}); // page → DOM 节点（跳转 / 视口定位）
  const [showFloatingLike, setShowFloatingLike] = useState(true);
  // 已保存到本地的页 → 本地 blob URL（灯箱直接用本地文件，避免重复下载）
  const [localSrcs, setLocalSrcs] = useState({});
  const prevLocalSrcsRef = useRef({});
  const [localResolved, setLocalResolved] = useState(false); // 当前作品本地解析是否完成
  const lastRestoreRef = useRef(null); // 最近一次滚动恢复记录（用于数据就绪后校正）

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
    // 清空本地 URL 缓存，避免跨作品误用上一张图的本地原图
    setLocalSrcs({});
    prevLocalSrcsRef.current = {};
    setLocalResolved(false);
  }, [image?.illustId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 切换作品时恢复滚动位置：用 useLayoutEffect 在浏览器绘制前同步滚动，
  // 避免先闪到顶部/第 0 页、再跳到入口高度（多页作品非首页进入或回退时）。
  useLayoutEffect(() => {
    if (!image?.illustId) return;
    const target = image?._pageIndex ?? 0;
    const el = contentRef.current;
    if (!el) return;
    if (target > 0) {
      const node = pageRefs.current[target];
      if (node) node.scrollIntoView({ block: 'start' });
    } else {
      el.scrollTop = restoreScroll || 0;
    }
    lastRestoreRef.current = { illustId: image.illustId, target, appliedTop: el.scrollTop };
  }, [image?.illustId, image?._pageIndex, restoreScroll]);

  // 详情数据加载完、页面真实高度就绪后，校正一次滚动位置（仅当用户尚未手动滚动时）
  useEffect(() => {
    const last = lastRestoreRef.current;
    if (!last || !illustData || last.illustId !== image?.illustId) return;
    const el = contentRef.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - last.appliedTop) > 40) return; // 用户已手动滚动，不打扰
    if (last.target > 0) {
      const node = pageRefs.current[last.target];
      if (node) node.scrollIntoView({ block: 'start' });
    } else {
      el.scrollTop = last.appliedTop;
    }
  }, [illustData]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // 浏览时回填：已保存/喜欢的实体缺元数据时，把 完整缩略图URL/标题/作者/tags 写回并更新备份
  // （这样「喜欢」页无需依赖 pixiv.re 短链反查，直接显示完整 URL 缩略图）
  useEffect(() => {
    if (!image?.illustId) return;
    const tags = Array.isArray(illustData?.illust?.tags) ? illustData.illust.tags.filter(Boolean) : [];
    const meta = {
      thumbnailUrl: image?.thumbnailUrl || illustData?.illust?.images?.[0]?.url || '',
      title: image?.title || illustData?.illust?.title || '',
      author: image?.authorName || image?.author || illustData?.illust?.authorName || '',
      authorName: image?.authorName || illustData?.illust?.authorName || '',
      authorId: image?.authorId || illustData?.illust?.authorId || '',
      tags,
    };
    if (!meta.thumbnailUrl && !meta.title && tags.length === 0) return;
    (async () => {
      const totalPages = Math.max(pageCount, image?._totalPages || 1);
      for (let p = 0; p < totalPages; p++) {
        const ck = getCompositeKey({ illustId: image.illustId, _pageIndex: p });
        const cur = pixivCache[ck];
        if (!cur?.saved && !cur?.liked) continue; // 只回填已保存/喜欢的条目
        await storageFacade.fillMeta(image.illustId, p, meta);
      }
    })().catch(() => {});
  }, [illustData, image, pixivCache, pageCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // 已保存页 → 本地 blob URL：灯箱直接读相册本地文件，不再走网络重新下载。
  // pixivCache 变化（保存/取消保存）时增量更新：复用已有 URL、新增刚保存的页、回收已取消的页。
  useEffect(() => {
    if (!image?.illustId) return;
    let cancelled = false;
    const totalPages = Math.max(pageCount, image?._totalPages || 1);
    (async () => {
      const map = {};
      const prev = prevLocalSrcsRef.current;
      for (let p = 0; p < totalPages; p++) {
        const ck = getCompositeKey({ illustId: image.illustId, _pageIndex: p });
        if (!pixivCache[ck]?.saved) continue;
        if (prev[p]) { map[p] = prev[p]; continue; } // 复用已有本地 URL，避免重复读相册
        const r = await storageFacade.load(image.illustId, p).catch(() => null);
        if (cancelled) return;
        if (r?.localUrl) map[p] = r.localUrl;
      }
      if (cancelled) return;
      // 回收不再使用（已取消保存 / 切换作品）的旧 blob URL
      for (const [p, u] of Object.entries(prev)) {
        if (map[p] !== u) URL.revokeObjectURL(u);
      }
        const unchanged = Object.keys(map).length === Object.keys(prev).length
          && Object.keys(map).every(p => map[p] === prev[p]);
        prevLocalSrcsRef.current = map;
        if (!unchanged) setLocalSrcs(map);
        setLocalResolved(true);
      })();
    return () => { cancelled = true; };
  }, [image?.illustId, pixivCache, pageCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // 构造保存条目（单页）— 优先用详情接口的完整日期路径 URL（避免走 pixiv.re 短链反查）
  const buildSaveItem = useCallback((page, images) => {
    const imgs = images || illustData?.illust?.images || [];
    const pg = imgs[page] || {};
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
      tags: image.tags || [],
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
      pages.push({ item: buildSaveItem(p, imgs), ck });
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

  // 长按图片 → 下载该页原图（单页保存）
  const downloadPage = useCallback(async (page) => {
    if (!image?.illustId) return;
    const ck = getCompositeKey({ illustId: image.illustId, _pageIndex: page });
    // 不再硬拦截「已在相册」的页：照常走保存流程，
    // saveFromNetwork 对已存在文件会自动跳过真实下载、只补元数据，不会重复下载。
    const alreadySaved = !!pixivCache[ck]?.saved;
    // 确保拿到完整日期路径原图 URL：详情未加载就补拉一次（否则会退回 pixiv.re 短链，短链当前不可用）
    let imgs = illustData?.illust?.images || [];
    if (imgs.length === 0) {
      try {
        const r = await pixivApi.fetchIllust(image.illustId);
        if (r?.illust?.images?.length) imgs = r.illust.images;
      } catch (e) {
        log.debug('单页下载补拉详情失败，保持兜底 URL:', e?.message || e);
      }
    }
    showToast(alreadySaved ? '该页已在相册中' : `开始下载第 ${page + 1} 页…`);
    try {
      const r = await saveItem(buildSaveItem(page, imgs));
      if (r?.success || r?.cached) {
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], cached: true, saved: true } }));
        showToast(alreadySaved ? '该页已在相册中' : `已保存第 ${page + 1} 页到相册`);
      } else {
        showToast('下载失败');
      }
    } catch (e) {
      log.warn('单页下载失败:', page, e?.message || e);
      showToast('下载失败');
    }
  }, [image, buildSaveItem, pixivCache, setPixivCache, illustData]);

  // 灯箱媒体项：点击大图弹出全屏预览（按 detailQuality 加载原图档）。
  // 滚动视图只显示最小等比预览图，原图在灯箱按需加载。
  const lightboxMedia = (() => {
    if (!image?.illustId) return [];
    const totalPages = Math.max(pageCount, image?._totalPages || 1);
    const items = [];
    const imgs = illustData?.illust?.images || [];
    const useRegular = getSettingsSync().detailQuality === 'regular';
    for (let p = 0; p < totalPages; p++) {
      // 已保存的页优先用本地 blob URL；未保存才走网络原图
      let src = localSrcs[p] || (useRegular ? imgs[p]?.url : imgs[p]?.originalUrl) || imgs[p]?.url || imgs[p]?.originalUrl;
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
        // 真实尺寸（详情接口）：供灯箱双击缩放计算倍率，避免依赖 img.naturalWidth（加载前为 0 导致前后不一致）
        width: image?.width || illustData?.illust?.width || 0,
        height: image?.height || illustData?.illust?.height || 0,
        // small 图（540px，同比例）——灯箱原图逐行渲染时托底，避免底部空黑
        previewUrl: imgs[p]?.previewUrl || '',
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

  // 相关推荐进入视口 且 已滚动 ≥300px 才隐藏悬浮爱心（避免宽图一进来就隐藏）
  useEffect(() => {
    const el = relatedRef.current;
    const root = contentRef.current;
    if (!el || !root) return;
    const update = () => {
      setShowFloatingLike(!(relatedInViewRef.current && root.scrollTop >= 300));
    };
    const io = new IntersectionObserver(([e]) => {
      relatedInViewRef.current = e.isIntersecting;
      update();
    }, { root, threshold: 0.05 });
    io.observe(el);
    root.addEventListener('scroll', update, { passive: true });
    update();
    return () => { io.disconnect(); root.removeEventListener('scroll', update); };
  }, [related.length, image?.illustId]);

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
              {Array.from({ length: pageCount }, (_, p) => {
                const ck = getCompositeKey({ illustId: image.illustId, _pageIndex: p });
                const isSaved = !!pixivCache[ck]?.saved;
                const localUrl = localSrcs[p];
                // 已保存页：本地原图优先；本地尚未解析完成时先显示模糊托底，
                // 避免「网络预览 → 原图」的闪烁
                let heroUrl = localUrl;
                if (!heroUrl && !(isSaved && !localResolved)) {
                  heroUrl = illustData?.illust?.images?.[p]?.previewUrl
                    || illustData?.illust?.images?.[p]?.url
                    || '';
                }
                return (
                  <DetailPageBlock
                    key={`${image.illustId}-${p}`}
                    page={p}
                    totalPages={pageCount}
                    image={image}
                    previewUrl={heroUrl}
                    defaultRatio={defaultRatio}
                    registerRef={(page, node) => { pageRefs.current[page] = node; }}
                    onOpenLightbox={(page) => setLightboxIndex(page)}
                    onLongPress={downloadPage}
                  />
                );
              })}
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
            {(() => {
              // O(n) 去重：同一作品只渲染一次（保留首条），替代原先 map 内 findIndex 的 O(n²)
              const seen = new Set();
              return related.map((img) => {
                if (img._pageIndex !== 0) return null;
                if (seen.has(img.illustId)) return null;
                seen.add(img.illustId);
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
              });
            })()}
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

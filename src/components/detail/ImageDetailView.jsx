import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { saveItem } from '../../api/index.js';
import { saveAllPages as saveAllPagesShared } from '../../api/saveAllPages.js';
import { pixivReUrl } from '../../pixiv-assistant/core/utils.js';
import { getCompositeKey } from '../../pixiv-assistant/core/utils.js';
import { LikeButton } from '../LightboxActions.jsx';
import MediaLightbox from '../MediaLightbox.jsx';
import UgoiraPlayer from '../UgoiraPlayer.jsx';
import FollowIcon from '../icons/FollowIcon.jsx';
import DetailPageBlock from './DetailPageBlock.jsx';
import RelatedGrid from './RelatedGrid.jsx';
import { usePixivCache } from '../../context/pixivCacheContext.js';
import { parsePixivResults } from './helpers.js';
import { useAuthorProfile } from '../../hooks/useAuthorProfile.js';
import { useGridLikeToggle } from '../../hooks/useGridLikeToggle.js';
import { getSettingsSync, storageFacade } from '../../pixiv-assistant/index.js';
import { registerBackHandler } from '../../utils/backHandler.js';
import { createLogger } from '../../utils/logger.js';
import { showToast } from '../../utils/toast.js';
import { buildLikedOrSavedSet } from '../../utils/worksState.js';

const log = createLogger('ImageDetail');
/** 批量保存时的最大并发页数 */

/**
 * 图片详情页 — 全屏展示大图 + 信息 + 操作 + 相关推荐网格。
 * 点击图片进入，往下滑看推荐，点推荐图片切换详情。
 */
export default function ImageDetailView({
  image, onSelectImage, onAuthorWorks, onSearchTag,
  restoreScroll = 0,
  restoreAnchor = null,
}) {
  const { pixivCache, setPixivCache } = usePixivCache();
  const toggleLike = useGridLikeToggle();
  // 已喜欢/已保存的作品不进入相关推荐；当前作品本身也排除
  const likedOrSavedSet = useMemo(() => buildLikedOrSavedSet(pixivCache), [pixivCache]);
  const [related, setRelated] = useState([]);
  const [loadingRelated, setLoadingRelated] = useState(false);
  const relatedCacheRef = useRef({}); // illustId → { related, loadedPages }
  const [lightboxIndex, setLightboxIndex] = useState(null); // 灯箱：点击大图打开全屏预览
  const [illustData, setIllustData] = useState(null);
  const authorId = String(image?.authorId || illustData?.illust?.authorId || '');
  const {
    avatar: authorAvatar,
    isFollowed: authorIsFollowed,
    updating: followUpdating,
    toggleFollow,
  } = useAuthorProfile(authorId, image?.authorAvatar);
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
  const ratioCacheRef = useRef({}); // illustId → { page: "w / h" }，返回时复用，避免高度二次校准闪动
  const userInteractedAfterRestoreRef = useRef(false); // 恢复后用户是否已主动操作滚动/触控

  // 兼容旧数据：列表接口映射可能只带 illustType 不带 type
  const isGif = image?.type === 'gif' || Number(image?.illustType) === 2;
  // Tag 展示：优先列表返回的 tag；列表没带（如作者页/关注流，可能为空数组）则等 fetchIllust 回来用 API 的 tag 兜底
  const listTags = Array.isArray(image?.tags) ? image.tags : [];
  const apiTags = Array.isArray(illustData?.illust?.tags) ? illustData.illust.tags : [];
  const tags = (listTags.length ? listTags : apiTags).filter(Boolean).slice(0, 12);
  const pageCount = Math.max(
    illustData?.illust?.pageCount || 0,
    illustData?.illust?.images?.length || 0,
    image?._totalPages || 0,
    image?.pageCount || 0,
    1,
  );
  const ratioOfSize = (w, h) => (w && h ? `${w} / ${h}` : '');
  // 详情页占位宽高比：优先真实尺寸，拿不到用常见 3:4 兜底
  const defaultRatio = (() => {
    const p0 = illustData?.illust?.images?.[0];
    const w = p0?.width || image?.width || illustData?.illust?.width || 0;
    const h = p0?.height || image?.height || illustData?.illust?.height || 0;
    return w && h ? `${w} / ${h}` : '3 / 4';
  })();
  const pageRatios = ratioCacheRef.current[image?.illustId] || {};
  const rememberPageRatio = useCallback((page, nextRatio) => {
    if (!image?.illustId || !nextRatio) return;
    const prev = ratioCacheRef.current[image.illustId] || {};
    if (prev[page] === nextRatio) return;
    ratioCacheRef.current[image.illustId] = { ...prev, [page]: nextRatio };
  }, [image?.illustId]);

  const markUserInteracted = useCallback(() => {
    userInteractedAfterRestoreRef.current = true;
  }, []);

  const registerPageRef = useCallback((page, node) => {
    if (node) pageRefs.current[page] = node;
    else delete pageRefs.current[page];
  }, []);

  const applyScrollRestore = useCallback(() => {
    const target = image?._pageIndex ?? 0;
    const el = contentRef.current;
    if (!el) return 0;

    // 优先按锚点恢复：保存"第一个可见图片块/相关推荐块距离容器顶部的偏移"。
    // 当前面图片高度因异步比例/本地原图变化时，锚点恢复比裸 scrollTop 更稳定。
    if (restoreAnchor?.id) {
      const node = el.querySelector(`[data-detail-anchor="${restoreAnchor.id}"]`);
      if (node) {
        const rootTop = el.getBoundingClientRect().top;
        const nodeTop = node.getBoundingClientRect().top;
        el.scrollTop += nodeTop - rootTop - (restoreAnchor.delta || 0);
        return el.scrollTop;
      }
    }

    if (target > 0) {
      const node = pageRefs.current[target];
      if (node) node.scrollIntoView({ block: 'start' });
    } else {
      el.scrollTop = restoreScroll || 0;
    }
    return el.scrollTop;
  }, [image?._pageIndex, restoreAnchor, restoreScroll]);

  // 切换作品时重置详情数据（避免残留上一张作品的画面）
  useEffect(() => {
    setIllustData(null);
    setLightboxIndex(null);
    // 清空本地 URL 缓存，避免跨作品误用上一张图的本地原图
    setLocalSrcs({});
    prevLocalSrcsRef.current = {};
    setLocalResolved(false);
    return () => {
      // 卸载或切换作品时回收本实例持有的本地 blob URL，避免累积
      const prev = prevLocalSrcsRef.current;
      for (const u of Object.values(prev)) {
        try { URL.revokeObjectURL(u); } catch { /* 忽略 */ }
      }
    };
  }, [image?.illustId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 切换作品时恢复滚动位置：用 useLayoutEffect 在浏览器绘制前同步滚动，
  // 避免先闪到顶部/第 0 页、再跳到入口高度（多页作品非首页进入或回退时）。
  useLayoutEffect(() => {
    if (!image?.illustId) return;
    const target = image?._pageIndex ?? 0;
    const el = contentRef.current;
    if (!el) return;
    userInteractedAfterRestoreRef.current = false;
    const appliedTop = applyScrollRestore();
    lastRestoreRef.current = {
      illustId: image.illustId,
      target,
      appliedTop,
      anchor: restoreAnchor,
    };
  }, [image?.illustId, image?._pageIndex, restoreScroll, restoreAnchor, applyScrollRestore]);

  // 详情数据加载完、页面真实高度就绪后，校正一次滚动位置（仅当用户尚未手动滚动时）
  useEffect(() => {
    const last = lastRestoreRef.current;
    if (!last || !illustData || last.illustId !== image?.illustId) return;
    const el = contentRef.current;
    if (!el) return;
    if (userInteractedAfterRestoreRef.current) return; // 用户已手动滚动/触控，不打扰
    requestAnimationFrame(() => {
      if (userInteractedAfterRestoreRef.current) return;
      const appliedTop = applyScrollRestore();
      lastRestoreRef.current = { ...last, appliedTop };
    });
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
    const illust = illustData?.illust;
    if (!image?.illustId) return;
    const tags = Array.isArray(illust?.tags) ? illust.tags.filter(Boolean) : [];
    const p0 = illust?.images?.[0] || {};
    const meta = {
      thumbnailUrl: image?.thumbnailUrl || p0.thumbnailUrl || p0.previewUrl || p0.url || '',
      title: image?.title || illust?.title || '',
      author: image?.authorName || image?.author || illust?.authorName || illust?.author || '',
      authorName: image?.authorName || illust?.authorName || illust?.author || '',
      authorId: image?.authorId || illust?.authorId || '',
      pageCount: illust?.pageCount || 0,
      tags,
    };
    if (!meta.thumbnailUrl && !meta.title && !meta.authorName && tags.length === 0) return;
    (async () => {
      const totalPages = Math.max(pageCount, image?._totalPages || 1);
      for (let p = 0; p < totalPages; p++) {
        const ck = getCompositeKey({ illustId: image.illustId, _pageIndex: p });
        const cur = pixivCache[ck];
        if (!cur?.saved && !cur?.liked) continue; // 只回填已保存/喜欢的条目
        await storageFacade.fillMeta(image.illustId, p, meta);       // 补 tags / URL / 标题
        await storageFacade.backfillMeta(image.illustId, p, meta);   // 补 pageCount / pixivUrl
      }
    })().catch(() => {});
  }, [illustData, image, pixivCache, pageCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // 已保存页 → 本地 blob URL：灯箱直接读相册本地文件，不再走网络重新下载。
  // pixivCache 变化（保存/取消保存）时增量更新：复用已有 URL、新增刚保存的页、回收已取消的页。
  useEffect(() => {
    if (!image?.illustId) return;
    let cancelled = false;
    const totalPages = Math.max(pageCount, image?._totalPages || 1);
    const created = []; // 本次运行新建的 blob URL，取消时回收未提交部分
    (async () => {
      const map = {};
      const prev = prevLocalSrcsRef.current;
      for (let p = 0; p < totalPages; p++) {
        const ck = getCompositeKey({ illustId: image.illustId, _pageIndex: p });
        if (!pixivCache[ck]?.saved) continue;
        if (prev[p]) { map[p] = prev[p]; continue; } // 复用已有本地 URL，避免重复读相册
        const r = await storageFacade.load(image.illustId, p).catch(() => null);
        if (cancelled) return;
        if (r?.localUrl) { map[p] = r.localUrl; created.push(r.localUrl); }
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
    return () => {
      cancelled = true;
      // 仅回收尚未提交到 prevLocalSrcsRef 的新建 URL（异步加载中途被卸载/切换）
      const prevValues = new Set(Object.values(prevLocalSrcsRef.current));
      for (const u of created) {
        if (!prevValues.has(u)) {
          try { URL.revokeObjectURL(u); } catch { /* 忽略 */ }
        }
      }
    };
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

  // 保存全部页（长按❤️/喜欢单图时调用）— 与网格长按共用同一实现
  const saveAllPages = useCallback(async () => {
    return saveAllPagesShared(image, {
      pixivCache,
      setPixivCache,
      images: illustData?.illust?.images,
      totalPages: pageCount,
    });
  }, [image, pageCount, illustData, pixivCache, setPixivCache]);

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
    showToast(alreadySaved ? '该页已在相册中' : `开始下载第 ${page + 1} 页…`, { type: 'info' });
    try {
      const r = await saveItem(buildSaveItem(page, imgs));
      if (r?.success || r?.cached) {
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], cached: true, saved: true } }));
        showToast(r?.idempotent || r?.skipped ? '该页已在相册中' : `已保存第 ${page + 1} 页到相册`, { type: 'success' });
      } else {
        showToast('下载失败', { type: 'error' });
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
        thumbnailUrl: image?.thumbnailUrl || pixivReUrl(String(image.illustId), 0),
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
      <div
        className="char-state-content"
        ref={contentRef}
        onTouchStartCapture={markUserInteracted}
        onPointerDownCapture={markUserInteracted}
        onWheelCapture={markUserInteracted}
      >
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
                    defaultRatio={ratioOfSize(illustData?.illust?.images?.[p]?.width, illustData?.illust?.images?.[p]?.height) || defaultRatio}
                    cachedRatio={pageRatios[p]}
                    registerRef={registerPageRef}
                    onOpenLightbox={(page) => setLightboxIndex(page)}
                    onLongPress={downloadPage}
                    onRatioReady={rememberPageRatio}
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
                onClick={() => onAuthorWorks?.(image.authorId, image.authorName || image.author, image.authorAvatar)}>
                <span className="image-detail-avatar-wrap">
                  {authorAvatar
                    ? <img className="image-detail-author-avatar" src={authorAvatar} alt="" loading="lazy" />
                    : <span className="image-detail-author-avatar image-detail-author-avatar--placeholder" />}
                  {authorId && (
                    <button
                      className={`follow-btn${authorIsFollowed ? ' followed' : ''}`}
                      disabled={followUpdating}
                      aria-label={authorIsFollowed ? '已关注' : '关注'}
                      onClick={(e) => { e.stopPropagation(); toggleFollow(); }}
                    >
                      <FollowIcon followed={authorIsFollowed} />
                    </button>
                  )}
                </span>
                <span className="image-detail-author-text">
                  <span className="image-detail-author-name">{image.authorName || image.author}</span>
                  <span className="image-detail-author-sub">
                    {illustData?.illust?.authorAccount && (
                      <span className="image-detail-author-account">@{illustData.illust.authorAccount}</span>
                    )}
                  </span>
                </span>
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
        {loadingRelated && (
          <div className="hint">正在加载相关推荐...</div>
        )}
        {related.length > 0 && (
          <RelatedGrid
            related={related}
            currentIllustId={image?.illustId}
            likedOrSavedSet={likedOrSavedSet}
            relatedRef={relatedRef}
            onSelectImage={onSelectImage}
            onLongPress={toggleLike}
          />
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

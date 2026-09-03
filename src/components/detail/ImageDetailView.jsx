import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { saveItem } from '../../api/index.js';
import { saveAllPages as saveAllPagesShared } from '../../api/saveAllPages.js';
import { pixivReUrl, pixivPageUrl } from '../../pixiv-assistant/core/utils.js';
import { masonryThumbUrl } from '../ImageGrid.jsx';
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
import { storageFacade } from '../../pixiv-assistant/index.js';
import { registerBackHandler } from '../../utils/backHandler.js';
import { createLogger } from '../../utils/logger.js';
import { showToast } from '../../utils/toast.js';
import { buildLikedOrSavedSet } from '../../utils/worksState.js';

const log = createLogger('ImageDetail');
const RELATED_PAGE_SIZE = 30;
// 相关推荐模块级缓存（跨详情实例共享）：返回上一作品时 ImageDetailView 因 key 变化整体重挂载，
// 实例内缓存会丢失、推荐区需重新走网络，导致滚动恢复等待且闪烁。LRU 上限防长会话膨胀。
const relatedCache = new Map();
const RELATED_CACHE_MAX = 20;

/**
 * 图片详情页 — 全屏展示大图 + 信息 + 操作 + 相关推荐网格。
 * 点击图片进入，往下滑看推荐，点推荐图片切换详情。
 */
export default function ImageDetailView({
  image, onSelectImage, onAuthorWorks, onSearchTag,
  restoreScroll = 0,
  restoreAnchor = null,
  className = '',
}) {
  const { pixivCache, setPixivCache } = usePixivCache();
  const toggleLike = useGridLikeToggle();
  // 已喜欢/已保存的作品不进入相关推荐；当前作品本身也排除
  const likedOrSavedSet = useMemo(() => buildLikedOrSavedSet(pixivCache), [pixivCache]);
  const [related, setRelated] = useState([]);
  const [loadingRelated, setLoadingRelated] = useState(false);
  const [loadingMoreRelated, setLoadingMoreRelated] = useState(false);
  const [relatedHasMore, setRelatedHasMore] = useState(false);
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
  const relatedSentinelRef = useRef(null); // 相关推荐分页触底哨兵
  const relatedInViewRef = useRef(false); // 相关推荐是否在视口内
  const relatedNextStartRef = useRef(0);
  const loadingRelatedRef = useRef(false);
  const relatedRequestSeqRef = useRef(0);
  const currentIllustIdRef = useRef('');
  const backfillFingerprintRef = useRef({}); // illustId → meta 指纹，避免每次 like/save 重复回填
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
  currentIllustIdRef.current = image?.illustId ? String(image.illustId) : '';
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
  }, [image?.illustId]); // oxlint-disable-line react-hooks/exhaustive-deps

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

  // 详情数据/相关推荐渲染后校正滚动位置（仅当用户尚未手动滚动时）。
  // 返回上一作品时组件因 key 变化整体重挂载，related 需重新渲染——高度就绪前
  // 恢复 scrollTop 会被钳制、锚点节点也不存在，必须等 related 渲染后再校正。
  useEffect(() => {
    const last = lastRestoreRef.current;
    if (!last || last.illustId !== image?.illustId) return;
    if (!illustData && !related.length) return; // 至少一个数据源到位才有校正意义
    const el = contentRef.current;
    if (!el) return;
    if (userInteractedAfterRestoreRef.current) return; // 用户已手动滚动/触控，不打扰
    requestAnimationFrame(() => {
      if (userInteractedAfterRestoreRef.current) return;
      const appliedTop = applyScrollRestore();
      lastRestoreRef.current = { ...last, appliedTop };
    });
  }, [illustData, related.length]); // oxlint-disable-line react-hooks/exhaustive-deps

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
    // 幂等守卫：同一作品的 meta 指纹未变化则不重复回填（避免每次 like/save 对全部已保存页重跑存储 I/O）
    const fingerprint = JSON.stringify(meta);
    if (backfillFingerprintRef.current[image.illustId] === fingerprint) return;
    backfillFingerprintRef.current[image.illustId] = fingerprint;
    (async () => {
      const totalPages = Math.max(pageCount, image?._totalPages || 1);
      for (let p = 0; p < totalPages; p++) {
        const ck = getCompositeKey({ illustId: image.illustId, _pageIndex: p });
        const cur = pixivCache[ck];
        if (!cur?.saved && !cur?.liked) continue; // 只回填已保存/喜欢的条目
        await storageFacade.fillMeta(image.illustId, p, meta);       // 补 tags / URL / 标题
        await storageFacade.backfillMeta(image.illustId, p, meta);   // 补 pageCount / pixivUrl
      }
    })().catch(() => { });
  }, [illustData, image, pixivCache, pageCount]); // oxlint-disable-line react-hooks/exhaustive-deps

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
  }, [image?.illustId, pixivCache, pageCount]); // oxlint-disable-line react-hooks/exhaustive-deps

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
    // 已在相册的页由最终分支统一提示，避免「已保存」提示重复弹两次
    if (!alreadySaved) showToast(`开始下载第 ${page + 1} 页…`, { type: 'info' });
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

  // 灯箱媒体项：点击大图弹出全屏预览（直接加载原图档）。
  // useMemo：仅依赖详情/本地URL/作品变化，避免相关推荐追加、缓存更新等无关渲染
  // 反复重建数组引用，触发 MediaLightbox 相邻预加载 effect 重复 new Image() 预热。
  const lightboxMedia = useMemo(() => {
    if (!image?.illustId) return [];
    const totalPages = Math.max(pageCount, image?._totalPages || 1);
    const items = [];
    const imgs = illustData?.illust?.images || [];
    for (let p = 0; p < totalPages; p++) {
      // 灯箱候选链：本地原图 → 原图（全分辨率）→ master1200 降级 → pixiv.re 短链 → 网格缩略图。
      // 原图优先，保证灯箱显示全分辨率画质；master1200 及以下仅作降级兜底。
      const masterUrl = imgs[p]?.url || imgs[p]?.mediumUrl || '';
      const p0Master = imgs[0]?.url || imgs[0]?.mediumUrl || image?.thumbnailUrl || '';
      const candidates = [...new Set([
        localSrcs[p] || '',
        imgs[p]?.originalUrl || '',
        masterUrl,
        p0Master ? pixivPageUrl(p0Master, p) : '',
        pixivReUrl(String(image.illustId), p),
        p === 0 ? masonryThumbUrl(image?.thumbnailUrl || '') : '',
      ].filter(Boolean))];
      items.push({
        type: isGif ? 'gif' : 'image',
        src: candidates[0] || '',
        candidates,
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
  }, [image, illustData, localSrcs, pageCount, isGif]);

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

  const loadRelatedPage = useCallback(async ({ append = false, requestSeq } = {}) => {
    const illustId = image?.illustId ? String(image.illustId) : '';
    if (!illustId || loadingRelatedRef.current) return;
    const activeSeq = requestSeq || relatedRequestSeqRef.current;
    const isCurrentRequest = () => (
      relatedRequestSeqRef.current === activeSeq &&
      currentIllustIdRef.current === illustId
    );
    const start = append ? relatedNextStartRef.current : 0;
    loadingRelatedRef.current = true;
    if (append) setLoadingMoreRelated(true);
    else setLoadingRelated(true);
    try {
      const result = await pixivApi.fetchRelated(illustId, {
        limit: RELATED_PAGE_SIZE,
        start,
      });
      if (!isCurrentRequest()) return;
      const rawList = result?.illusts || [];
      const parsed = rawList.length > 0 ? parsePixivResults(rawList) : [];
      const nextStart = start + rawList.length;
      const hasMore = rawList.length >= RELATED_PAGE_SIZE;
      setRelated(prev => {
        if (!isCurrentRequest()) return prev;
        const base = append ? prev : [];
        const seen = new Set(base.map(item => item.illustId));
        const merged = [...base];
        for (const item of parsed) {
          if (seen.has(item.illustId)) continue;
          seen.add(item.illustId);
          merged.push(item);
        }
        relatedCache.set(illustId, { related: merged, nextStart, hasMore });
        if (relatedCache.size > RELATED_CACHE_MAX) {
          relatedCache.delete(relatedCache.keys().next().value); // 淘汰最旧
        }
        return merged;
      });
      relatedNextStartRef.current = nextStart;
      setRelatedHasMore(hasMore);
    } catch (e) {
      if (!isCurrentRequest()) return;
      log.warn('fetchRelated failed:', e);
      if (!append) setRelatedHasMore(false);
    } finally {
      if (isCurrentRequest()) {
        loadingRelatedRef.current = false;
        setLoadingRelated(false);
        setLoadingMoreRelated(false);
      }
    }
  }, [image?.illustId]);

  // 加载相关推荐（优先缓存）
  useEffect(() => {
    if (!image?.illustId) return;
    const illustId = String(image.illustId);
    relatedRequestSeqRef.current += 1;
    const requestSeq = relatedRequestSeqRef.current;
    loadingRelatedRef.current = false;
    const cached = relatedCache.get(illustId);
    if (cached) {
      setRelated(cached.related);
      relatedNextStartRef.current = cached.nextStart || cached.related?.length || 0;
      setRelatedHasMore(!!cached.hasMore);
      setLoadingRelated(false);
      setLoadingMoreRelated(false);
      return;
    }
    setRelated([]);
    relatedNextStartRef.current = 0;
    setRelatedHasMore(false);
    loadRelatedPage({ append: false, requestSeq });
  }, [image?.illustId, loadRelatedPage]);

  // 相关推荐滚到底部自动追加
  useEffect(() => {
    const root = contentRef.current;
    const el = relatedSentinelRef.current;
    if (!root || !el || !relatedHasMore) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && relatedHasMore && !loadingRelatedRef.current) {
        loadRelatedPage({ append: true });
      }
    }, { root, rootMargin: '420px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [relatedHasMore, loadRelatedPage, related.length]);

  return (
    <div className={`char-state-bar${className ? ` ${className}` : ''}`}>
      <div
        className="char-state-content"
        ref={contentRef}
        onTouchStartCapture={markUserInteracted}
        onPointerDownCapture={markUserInteracted}
        onWheelCapture={markUserInteracted}
      >
        {/* GIF 动图：用动图播放器 */}
        <div className="detail-media-stack">
          {isGif ? (
            <div className="detail-gif-wrap" onClick={() => setLightboxIndex(0)}>
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
              <div className="detail-page-stack">
                {Array.from({ length: pageCount }, (_, p) => {
                  const ck = getCompositeKey({ illustId: image.illustId, _pageIndex: p });
                  const isSaved = !!pixivCache[ck]?.saved;
                  const localUrl = localSrcs[p];
                  // 已保存页：本地原图优先；本地尚未解析完成时先显示模糊托底，
                  // 避免「网络预览 → 原图」的闪烁
                  let heroUrl = localUrl;
                  if (!heroUrl && !(isSaved && !localResolved)) {
                    const imgs = illustData?.illust?.images || [];
                    if (p === 0) {
                      // 第 0 页：网格缩略图（540px 等比 small 档）稳定优先，
                      // 不随详情接口返回而切换 src，避免图片重挂载导致整页闪烁。
                      heroUrl = masonryThumbUrl(image?.thumbnailUrl || image?.mediumUrl || '')
                        || imgs[p]?.previewUrl
                        || imgs[p]?.url
                        || imgs[p]?.mediumUrl
                        || pixivPageUrl(image?.thumbnailUrl || image?.mediumUrl || '', p);
                    } else {
                      // 后续页：只用详情接口的 small 档 previewUrl，与第 0 页画质一致；
                      // 接口未就绪时保持空（占位），不先落到 master 大图再切回来造成跳变。
                      heroUrl = imgs[p]?.previewUrl || '';
                      if (!heroUrl && imgs.length) {
                        heroUrl = imgs[p]?.url
                          || imgs[p]?.mediumUrl
                          || pixivPageUrl(image?.thumbnailUrl || image?.mediumUrl || '', p);
                      }
                    }
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
        </div>

        <div className="detail-author-panel">
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
        </div>

        <div className="detail-related-panel">
          {loadingRelated && (
            <div className="hint">正在加载相关推荐...</div>
          )}
          {related.length > 0 && (
            <>
              <div className="detail-related-panel-header">相关推荐</div>
              <RelatedGrid
                related={related}
                currentIllustId={image?.illustId}
                likedOrSavedSet={likedOrSavedSet}
                relatedRef={relatedRef}
                onSelectImage={onSelectImage}
                onLongPress={toggleLike}
              />
              {relatedHasMore && <div ref={relatedSentinelRef} style={{ height: 1 }} />}
              {loadingMoreRelated && <div className="hint">加载更多推荐...</div>}
              {!loadingMoreRelated && !relatedHasMore && <div className="hint">没有更多推荐了</div>}
            </>
          )}
          {/* 底部间距 */}
          <div style={{ height: 24 }} />
        </div>
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
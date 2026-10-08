import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { saveItem } from '../../api/index.js';
import { saveAllPages as saveAllPagesShared } from '../../api/saveAllPages.js';
import { pixivReUrl, pixivPageUrl } from '../../pixiv-assistant/core/utils.js';
import { masonryThumbUrl } from '../../utils/imageUrl.js';
import { isImageLoaded } from '../../utils/loadedImages.js';
import { getSource } from '../../sources/registry.js';
import { booruApiFor } from '../../sources/api.js';
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
import { StatusBar } from '@capacitor/status-bar';

const log = createLogger('ImageDetail');
// Pixiv 的 recommend/init 不是可翻页列表：start 基本无效（同一作品换 start 仍是同一批），
// 推荐池本身有上限（实测约 85 条），limit 拉满即一次返回全部——所以不做无限滚动，一次取完。
const RELATED_FETCH_LIMIT = 100;
// 相关推荐模块级缓存（跨详情实例共享）：返回上一作品时 ImageDetailView 因 key 变化整体重挂载，
// 实例内缓存会丢失、推荐区需重新走网络，导致滚动恢复等待且闪烁。LRU 上限防长会话膨胀。
const relatedCache = new Map();
const RELATED_CACHE_MAX = 20;

/** 操作条图标规格：与侧边栏/设置齿轮一致（24 视窗、currentColor 描边、线宽 2） */
const actionIconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

/**
 * 宽高比超过它就用「图在上、信息在下」的上下布局。
 * 桌面端左右分栏时宽图被压在左列（1200px 窗口只有 628px 宽），铺满内容区能大一圈。
 * 调阈值只改这里；判定在 ImageDetailView，样式见 detail.css 的 char-state-content--wide。
 */
const WIDE_LAYOUT_RATIO = 1;

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
  const { pixivCache, setPixivCache, recommendationExcludedSet } = usePixivCache();
  const toggleLike = useGridLikeToggle();
  // 相关推荐只排除启动前已喜欢/已保存的作品，避免当前会话的收藏让卡片立即消失。
  const excludedAtStartup = recommendationExcludedSet || new Set();
  const [related, setRelated] = useState([]);
  const [loadingRelated, setLoadingRelated] = useState(false);
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
  const loadingRelatedRef = useRef(false);
  const relatedRequestSeqRef = useRef(0);
  const currentIllustIdRef = useRef('');
  const backfillFingerprintRef = useRef({}); // illustId → meta 指纹，避免每次 like/save 重复回填
  const pageRefs = useRef({}); // page → DOM 节点（跳转 / 视口定位）
  const [showFloatingLike, setShowFloatingLike] = useState(true);
  // 已保存到本地的页 → 本地 blob URL（灯箱直接用本地文件，避免重复下载）
  const [localSrcs, setLocalSrcs] = useState({});
  const prevLocalSrcsRef = useRef({});
  const lastRestoreRef = useRef(null); // 最近一次滚动恢复记录（用于数据就绪后校正）
  const ratioCacheRef = useRef({}); // illustId → { page: "w / h" }，返回时复用，避免高度二次校准闪动
  const reuseHdRef = useRef({}); // page → 可复用的高清源；见 render 里「档位复用」的说明
  const userInteractedAfterRestoreRef = useRef(false); // 恢复后用户是否已主动操作滚动/触控

  // 兼容旧数据：列表接口映射可能只带 illustType 不带 type
  const isGif = image?.type === 'gif' || Number(image?.illustType) === 2;
  // 来源：详情页据此在「Pixiv 接口」与「booru 接口」之间分流。
  // 老数据没有 source 字段（历史收藏/备份）→ 落回 pixiv，行为与改动前一致。
  const source = image?.source || 'pixiv';
  const isBooru = source !== 'pixiv';
  // 宽屏下详情栏能到 600px 以上，540 档预览会被拉伸到模糊，主图改取 1200 档。
  // 断点对应 index.css 的 @media (min-width: 900px)；窗口尺寸变化不重渲染，
  // 但换一张作品就会重算，实际用不到边拖边变的场景。
  const useLargePreview = typeof window !== 'undefined' && window.innerWidth >= 900;
  const booruApi = booruApiFor(source);
  const caps = getSource(source).caps;
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

  // 宽图 → 上下布局（见 WIDE_LAYOUT_RATIO）。比例优先取本页：实测缓存 > 接口尺寸 > 列表尺寸；
  // 都拿不到时沿用 defaultRatio 的占位兜底（3:4），那种情况保持原来的左右分栏最安全。
  const wideLayout = (() => {
    const page = image?._pageIndex ?? 0;
    const src = pageRatios[page]
      || ratioOfSize(illustData?.illust?.images?.[page]?.width, illustData?.illust?.images?.[page]?.height)
      || ratioOfSize(image?.width, image?.height)
      || defaultRatio;
    const [w, h] = String(src).split('/').map(v => parseFloat(v));
    return !!w && !!h && w / h > WIDE_LAYOUT_RATIO;
  })();

  const rememberPageRatio = useCallback((page, nextRatio) => {
    if (!image?.illustId || !nextRatio) return;
    const prev = ratioCacheRef.current[image.illustId] || {};
    if (prev[page] === nextRatio) return;
    ratioCacheRef.current[image.illustId] = { ...prev, [page]: nextRatio };
  }, [image?.illustId]);

  // 桌面端详情流的高清源：本地已保存的原图优先，其次详情接口给的原图直链
  // （取的是灯箱候选链的前两级，两边保持一致）。
  // booru 不参与 —— previewUrl 本身就是原图（见下面的档位注释），手机端也不加载。
  const hdUrlForPage = useCallback((p) => {
    if (!useLargePreview || isBooru) return '';
    return localSrcs[p] || illustData?.illust?.images?.[p]?.originalUrl || '';
  }, [useLargePreview, isBooru, localSrcs, illustData]);

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
        // booru 的一条 post 就是全部信息（单图），适配器返回同一形状的 { illust }
        const result = booruApi
          ? await booruApi.fetchIllust(image.illustId)
          : await pixivApi.fetchIllust(image.illustId);
        if (!cancelled) setIllustData(result);
      } catch (e) {
        // fetchIllust 失败 → illustData 保持 null，后续按页从 URL 推导
        log.warn('fetchIllust 失败:', image.illustId, e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, [image?.illustId, booruApi]);

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

  // 已保存页 → 本地 blob URL：仅在灯箱打开后读取，详情流不加载本地原图。
  // pixivCache 变化（保存/取消保存）时增量更新：复用已有 URL、新增刚保存的页、回收已取消的页。
  useEffect(() => {
    if (!image?.illustId || lightboxIndex === null) return;
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
  }, [image?.illustId, pixivCache, pageCount, lightboxIndex]); // oxlint-disable-line react-hooks/exhaustive-deps

  // 构造保存条目（单页）— 优先用详情接口的完整日期路径 URL（避免走 pixiv.re 短链反查）
  const buildSaveItem = useCallback((page, images) => {
    const imgs = images || illustData?.illust?.images || [];
    const pg = imgs[page] || {};
    // booru 的图床地址是直链，没有 pixiv.re 反查可用 → derived 恒为空，
    // 缺 URL 时只能依赖列表/详情带回的地址（booru 单图必有一份）
    const derived = !isBooru && image?.illustId ? pixivReUrl(String(image.illustId), page) : '';
    return {
      illustId: image.illustId,
      source,
      webUrl: image.webUrl || image.pixivUrl || '',
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
  }, [image, illustData, isGif, isBooru, source]);

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
    // booru 无短链可退：URL 全在条目里（mapPost 已给全），补拉 pixivApi 只会拿到同号的无关作品
    let imgs = illustData?.illust?.images || [];
    if (imgs.length === 0 && !isBooru) {
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
  }, [image, buildSaveItem, pixivCache, setPixivCache, illustData, isBooru]);

  // ── 桌面操作条：下载 / 复制链接 ──
  const [actionBusy, setActionBusy] = useState(false);
  // 图标钮没有文字，这个文案走 title / aria-label（窄栏下也能看清下载范围）
  const downloadLabel = actionBusy ? '下载中…' : (pageCount > 1 ? `下载全部 ${pageCount} 页` : '下载');

  const handleDownloadAction = useCallback(async () => {
    if (!image?.illustId || actionBusy) return;
    setActionBusy(true);
    try {
      if (pageCount > 1) {
        showToast(`开始下载全部 ${pageCount} 页…`, { type: 'info' });
        await saveAllPages(image, {
          pixivCache,
          setPixivCache,
          images: illustData?.illust?.images,
          totalPages: pageCount,
        });
      } else {
        await downloadPage(0);
      }
    } finally {
      setActionBusy(false);
    }
  }, [image, actionBusy, pageCount, downloadPage, pixivCache, setPixivCache, illustData, saveAllPages]);

  const handleCopyLink = useCallback(async () => {
    const url = image?.originalUrl || image?.mediumUrl || '';
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast('图片链接已复制', { type: 'success' });
    } catch (e) {
      log.warn('复制链接失败:', e?.message || e);
      showToast('复制失败');
    }
  }, [image]);

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
        // pixivPageUrl / pixivReUrl 只会拿 illustrateId 拼 pximg 路径：
        // 对 booru 的图床直链既拼不出正确地址，还会张冠李戴到同号 pixiv 作品上 → 仅 Pixiv 生成
        !isBooru && p0Master ? pixivPageUrl(p0Master, p) : '',
        !isBooru ? pixivReUrl(String(image.illustId), p) : '',
        p === 0 ? masonryThumbUrl(image?.thumbnailUrl || '', 0, source) : '',
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
        source,
        webUrl: image?.webUrl || image?.pixivUrl || '',
        author: image?.author || '',
        authorId: image?.authorId || '',
        authorName: image?.authorName || image?.author || '',
        pixivUrl: image?.pixivUrl || (isBooru ? '' : `https://www.pixiv.net/artworks/${image.illustId}`),
        // 真实尺寸（详情接口）：供灯箱双击缩放计算倍率，避免依赖 img.naturalWidth（加载前为 0 导致前后不一致）
        width: image?.width || illustData?.illust?.width || 0,
        height: image?.height || illustData?.illust?.height || 0,
        // small 图（540px，同比例）——灯箱原图逐行渲染时托底，避免底部空黑
        previewUrl: imgs[p]?.previewUrl || '',
        thumbnailUrl: image?.thumbnailUrl || (isBooru ? '' : pixivReUrl(String(image.illustId), 0)),
      });
    }
    return items;
  }, [image, illustData, localSrcs, pageCount, isGif, isBooru, source]);

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

  const loadRelated = useCallback(async ({ requestSeq } = {}) => {
    const illustId = image?.illustId ? String(image.illustId) : '';
    if (!illustId || loadingRelatedRef.current) return;
    // booru 站没有相关推荐接口：直接置空，区块随 related.length === 0 自动不渲染
    if (!caps.related) { setRelated([]); setLoadingRelated(false); return; }
    const activeSeq = requestSeq || relatedRequestSeqRef.current;
    const isCurrentRequest = () => (
      relatedRequestSeqRef.current === activeSeq &&
      currentIllustIdRef.current === illustId
    );
    loadingRelatedRef.current = true;
    setLoadingRelated(true);
    try {
      const result = await pixivApi.fetchRelated(illustId, { limit: RELATED_FETCH_LIMIT });
      if (!isCurrentRequest()) return;
      const rawList = result?.illusts || [];
      const parsed = rawList.length > 0 ? parsePixivResults(rawList) : [];
      const seen = new Set();
      const merged = [];
      for (const item of parsed) {
        if (seen.has(item.illustId)) continue;
        seen.add(item.illustId);
        merged.push(item);
      }
      relatedCache.set(illustId, merged);
      if (relatedCache.size > RELATED_CACHE_MAX) {
        relatedCache.delete(relatedCache.keys().next().value); // 淘汰最旧
      }
      setRelated(merged);
    } catch (e) {
      if (!isCurrentRequest()) return;
      log.warn('fetchRelated failed:', e);
    } finally {
      if (isCurrentRequest()) {
        loadingRelatedRef.current = false;
        setLoadingRelated(false);
      }
    }
  }, [image?.illustId, caps.related]);

  // 加载相关推荐（优先缓存）
  useEffect(() => {
    if (!image?.illustId) return;
    const illustId = String(image.illustId);
    relatedRequestSeqRef.current += 1;
    const requestSeq = relatedRequestSeqRef.current;
    loadingRelatedRef.current = false;
    const cached = relatedCache.get(illustId);
    if (cached) {
      setRelated(cached);
      setLoadingRelated(false);
      return;
    }
    setRelated([]);
    loadRelated({ requestSeq });
  }, [image?.illustId, loadRelated]);

  // 详情页滚动方向 → 隐藏/显示系统状态栏
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    // 挂载时**不碰**状态栏：它这一刻的状态就是「进入详情前网格的状态」，本来就是要继承的东西。
    // 以前这里按详情自己的 scrollTop 判断（新开一篇恒为 0）→ 必定发一次 show()，
    // 而从滚过的网格点进来时状态栏本是隐藏的：Android 上切换状态栏会伴随一次 WebView
    // 尺寸变化 → 整屏重排重绘（同一现象在下面的卸载注释和 DetailView 的离场处理里都记过），
    // 表现就是「点进详情页，内容高度跳一下」。只保留滚动时的方向判断就够。
    let lastTop = el.scrollTop || 0;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const top = el.scrollTop || 0;
        const delta = top - lastTop;
        if (top < 24) {
          try { StatusBar.show().catch(() => { }); } catch { }
        } else if (Math.abs(delta) > 6) {
          if (delta > 0) {
            try { StatusBar.hide().catch(() => { }); } catch { }
          } else {
            try { StatusBar.show().catch(() => { }); } catch { }
          }
        }
        lastTop = top;
        ticking = false;
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      // 这里不再 show()：卸载发生在离场动画结束、网格刚好露出的一帧，
      // 此时切换状态栏会触发一次 WebView 尺寸变化 → 整屏重排重绘 → 网格黑屏闪一下。
      // 状态栏已由 DetailView 在离场动画开始前对齐到主列表期望的状态。
    };
  }, [image?.illustId]);

  return (
    <div className={`char-state-bar${className ? ` ${className}` : ''}`}>
      <div
        className={`char-state-content${wideLayout ? ' char-state-content--wide' : ''}`}
        ref={contentRef}
        onTouchStartCapture={markUserInteracted}
        onPointerDownCapture={markUserInteracted}
        onWheelCapture={markUserInteracted}
      >
        {/* GIF 动图：用动图播放器 */}
        <div className="detail-media-stack">
          {isGif ? (
            /* 与 DetailPageBlock 一致：连击的第二下不打开灯箱（双击缩略图时它会落在刚挂上来的动图上） */
            <div className="detail-gif-wrap" onClick={(e) => { if (e.detail > 1) return; setLightboxIndex(0); }}>
              <UgoiraPlayer
                key={image?.illustId}
                illustId={image?.illustId}
                thumbnailUrl={image?.thumbnailUrl}
                source={source}
                width={image?.width || illustData?.illust?.width || 0}
                height={image?.height || illustData?.illust?.height || 0}
                hideInfo
                _lazy
                autoLoad={false}
                clickable={false}
                /* 桌面端主图有「媒体列 + 一屏」两条上限（--detail-media-*，见 detail.css），
                   静态图一直在用；动图这边原本按首帧像素写死宽高，横图会撑出媒体列、
                   纵图高过一屏。交回 CSS 收口，手机端（无这两条变量）保持原样。 */
                cssSized={useLargePreview}
              />
            </div>
          ) : (
            <>
              {/* 详情流只显示 540px 等比预览；原图和 regular 图仅在灯箱打开后按需加载。 */}
              <div className="detail-page-stack">
                {Array.from({ length: pageCount }, (_, p) => {
                  const imgs = illustData?.illust?.images || [];
                  // 每页都必须用「本页」的预览图。绝不能复用第 0 页的方形裁剪图，
                  // 否则多图作品的非首页会保持方形、比例错误。
                  const thumbBase = image?.thumbnailUrl || image?.mediumUrl || '';
                  // 占位图固定 540 档：由缩略图底座同步生成，不用等详情接口，秒开
                  const placeholderUrl = masonryThumbUrl(thumbBase, p, source)
                    || imgs[p]?.previewUrl
                    || '';
                  // 主图档位：
                  // · pixiv 走 1200 档等比预览（master1200），原图另由 hdUrl 叠上去；
                  // · booru 直接用原图 —— 它们的缩略图/中图是 16:9 裁剪（Wallhaven 的
                  //   small 300×200、lg 432×243 都裁过），铺在详情页既糊又是错的比例。
                  //   一条 post 就一张图，也不存在多页放大后的内存问题。
                  const hd = hdUrlForPage(p);
                  // 原图已经在手（本会话加载过 / 已保存到本地）时，master1200 那一档纯属浪费：
                  // 原图命中缓存的读取是免费的，再拉一张 1200 只是白下一份。直接拿原图当预览，
                  // 并把它从 hdUrl 让出去，免得同一张图渲染两层。
                  //
                  // 判定只在「本次挂载首次拿到该页高清源」时做一次，之后不再翻：
                  // 原图加载完成会让 isImageLoaded 翻成 true，若跟着变，主图 src 会在眼前
                  // 换一次（img 的 key 变化 → 重挂载 → 闪一帧 540 占位）。本次挂载内保持不变
                  // —— 原图那一层本来就已经在显示它了。
                  if (hd && reuseHdRef.current[p] === undefined) {
                    reuseHdRef.current[p] = (localSrcs[p] || isImageLoaded(hd)) ? hd : '';
                  }
                  const reuseHd = !!reuseHdRef.current[p];
                  // booru 的等比档：localSrcs → 中图 → 接口 previewUrl → 原图 → 缩略图底座。
                  // 关键是别退回 thumbnailUrl 当主图 —— Wallhaven 的缩略图是固定比例裁剪
                  // （实测每张都恒为 300×200），铺在详情页上比例直接是错的。
                  // 手机端也用这一档（一条 post 就一张图，中图/原图的流量可接受），
                  // pixiv 手机端仍走 540 档：那个前缀是「限制在 540×540 内」的等比缩放，不是裁剪。
                  const booruPreview = localSrcs[p] || image?.mediumUrl
                    || imgs[p]?.previewUrl || imgs[p]?.originalUrl || thumbBase;
                  const previewUrl = (isBooru
                    ? (useLargePreview
                      ? (localSrcs[p] || image?.originalUrl || imgs[p]?.originalUrl || booruPreview)
                      : booruPreview)
                    : (useLargePreview
                      ? (reuseHd ? hd : masonryThumbUrl(thumbBase, p, source, 1200))
                      : placeholderUrl)
                  ) || imgs[p]?.previewUrl || placeholderUrl;
                  // 占位框用的「预览图像素宽」：预览档位是长边封顶的等比图，竖图的实际宽度
                  // 远小于档位上限（1200 档发出的 810×1200 只有 810 宽）。不告诉 CSS 这个宽度，
                  // 大窗口下占位框会按媒体列铺满（1200），图到了再缩回自身宽度 —— 那一下就是
                  // 「尺寸突变」。桌面 booru / 复用原图走的都是原图，没有这层封顶，交 0 兜底 100%；
                  // 手机端 booru 用的是上游中图档，接口没给它的尺寸，也交 0 —— 宁可维持现状，
                  // 也别猜一个上限，猜错就是反方向的跳变，不如不猜。
                  const capPx = isBooru || reuseHd ? 0 : (useLargePreview ? 1200 : 540);
                  const previewW = (() => {
                    const w = Number(imgs[p]?.width || image?.width) || 0;
                    const h = Number(imgs[p]?.height || image?.height) || 0;
                    if (!capPx || !w || !h) return 0;
                    // 上游只缩不放：原图小于档位时就是它自己的尺寸
                    return Math.round(w * Math.min(1, capPx / Math.max(w, h)));
                  })();
                  return (
                    <DetailPageBlock
                      key={`${image.illustId}-${p}`}
                      page={p}
                      totalPages={pageCount}
                      image={image}
                      previewUrl={previewUrl}
                      hdUrl={reuseHd ? '' : hd}
                      placeholderUrl={placeholderUrl}
                      defaultRatio={ratioOfSize(illustData?.illust?.images?.[p]?.width, illustData?.illust?.images?.[p]?.height) || defaultRatio}
                      cachedRatio={pageRatios[p]}
                      previewNaturalWidth={previewW}
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
                <span className={`image-detail-author${caps.follow ? '' : ' image-detail-author--static'}`}
                  onClick={caps.follow ? () => onAuthorWorks?.(image.authorId, image.authorName || image.author, image.authorAvatar) : undefined}>
                  <span className="image-detail-avatar-wrap">
                    {authorAvatar
                      ? <img className="image-detail-author-avatar" src={authorAvatar} alt="" loading="lazy" />
                      : <span className="image-detail-author-avatar image-detail-author-avatar--placeholder" />}
                    {caps.follow && authorId && (
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
                href={image?.webUrl || image?.pixivUrl || (isBooru ? '' : `https://www.pixiv.net/artworks/${image.illustId}`)}
                target="_blank" rel="noreferrer"
                onClick={e => e.stopPropagation()}>
                {getSource(source).label}
              </a>
            </div>
          </div>

          {/* 桌面操作条：纯图标方块钮（手机端仍用图片上的悬浮爱心 + 长按下载，这里 ≥900px 才显示）。
              没有文字标签，语义全靠 title/aria-label；title 顺带承担「下载 3 页」这类提示 */}
          <div className="detail-actions">
            <LikeButton
              cur={image}
              onLikeSaveAll={saveAllPages}
              totalPages={pageCount}
              className="detail-action detail-action--fill"
            />
            <button
              className="detail-action detail-action--fill"
              onClick={handleDownloadAction}
              disabled={actionBusy}
              title={downloadLabel}
              aria-label={downloadLabel}
            >
              {actionBusy ? <span className="detail-action-spinner" /> : (
                <svg {...actionIconProps}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              )}
            </button>
            <button className="detail-action" onClick={handleCopyLink} title="复制链接" aria-label="复制链接">
              <svg {...actionIconProps}>
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </button>
            <button
              className="detail-action"
              onClick={() => setLightboxIndex(0)}
              title="查看原图"
              aria-label="查看原图"
            >
              <svg {...actionIconProps}>
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </svg>
            </button>
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
                excludedSet={excludedAtStartup}
                relatedRef={relatedRef}
                onSelectImage={onSelectImage}
                onLongPress={toggleLike}
              />
              <div className="hint">没有更多推荐了</div>
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
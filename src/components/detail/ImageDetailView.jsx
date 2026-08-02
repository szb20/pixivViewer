import { useState, useEffect, useRef, useCallback } from 'react';
import { proxyThumb, pixivReUrl } from '../../pixiv-assistant/core/utils.js';
import { getCompositeKey } from '../../pixiv-assistant/core/utils.js';
import PageHeader from '../PageHeader.jsx';
import LightboxActions, { LikeButton } from '../LightboxActions.jsx';
import MediaLightbox from '../MediaLightbox.jsx';
import UgoiraPlayer from '../UgoiraPlayer.jsx';
import { parsePixivResults, allMediaFromRelated } from './helpers.js';
import { getSettingsSync } from '../../pixiv-assistant/index.js';
import { gridThumbUrl } from '../../utils/quality.js';
import { registerBackHandler } from '../../utils/backHandler.js';

/**
 * 多图详情页的单页块 — 所有页面上下堆叠展示。
 * 进入视口时触发自动保存并懒加载原图（本地相册优先 → 网络原图），
 * 原图就绪前用缩略图模糊铺底；点击打开灯箱。
 */
function DetailPageBlock({ page, image, rootRef, registerRef, loadOriginal, onSavePage, onPageLoaded, onOpenLightbox, illustDataReady }) {
  const wrapRef = useRef(null);
  const [entry, setEntry] = useState(null); // { url, w, h }
  const [failed, setFailed] = useState(false);
  const loadedRef = useRef(false); // 已成功加载过则跳过重试

  // 进入视口 → 自动保存该页 + 懒加载原图
  // illustDataReady 变化时重试未成功加载的页面（本地文件缺失 + 网络 URL 需 illustData）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (loadedRef.current) return;
    let cancelled = false;
    let saved = false;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      if (!saved) {
        saved = true;
        onSavePage?.(page);
      }
      loadOriginal(image?.illustId, page).then(res => {
        if (cancelled) return;
        if (res?.url) { setEntry(res); setFailed(false); loadedRef.current = true; onPageLoaded?.(page, res); }
        else if (illustDataReady) setFailed(true); // illustData 就绪仍失败 → 真失败
        // illustData 未就绪 → 静默等待下次 retry
      });
    }, { root: rootRef?.current || null, rootMargin: '400px 0px' });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [image?.illustId, page, rootRef, loadOriginal, onSavePage, onPageLoaded, illustDataReady]);

  // 第 0 页：直接用列表传来的真缩略图；其它页：等 illustData 就绪后再显示
  const thumb = page === 0
    ? (image?.thumbnailUrl || pixivReUrl(String(image.illustId), 0, 'thumb'))
    : '';

  return (
    <div
      ref={(node) => { wrapRef.current = node; registerRef?.(page, node); }}
      className="image-detail-hero"
      onClick={() => onOpenLightbox?.(page)}
    >
      {thumb && <img className="image-detail-bg" src={thumb} alt="" />}
      {entry?.url ? (
        <img
          className="image-detail-main image-detail-main--flow"
          key={entry.url}
          src={entry.url}
          alt={`第 ${page + 1} 页`}
          onError={() => setFailed(true)}
        />
      ) : failed ? (
        <div className="image-detail-error">加载失败</div>
      ) : (
        page === 0 ? (
          <img
            className="image-detail-main image-detail-main--flow"
            src={thumb}
            alt={`第 ${page + 1} 页`}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="image-detail-placeholder" />
        )
      )}
    </div>
  );
}

/**
 * 图片详情页 — 全屏展示大图 + 信息 + 操作 + 相关推荐网格。
 * 点击图片进入，往下滑看推荐，点推荐图片切换详情。
 */
export default function ImageDetailView({
  image, onBack, onSelectImage, onAuthorWorks,
  pixivCache, setPixivCache,
}) {
  const [related, setRelated] = useState([]);
  const [loadingRelated, setLoadingRelated] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(null); // 灯箱：点击大图打开全屏预览
  const [illustData, setIllustData] = useState(null);
  const [loadedPages, setLoadedPages] = useState({}); // `${illustId}_${page}` → { url, w, h }（供灯箱读取已加载原图）
  const contentRef = useRef(null);
  const pageRefs = useRef({}); // page → DOM 节点（跳转 / 视口定位）
  // 已成功加载的原图缓存：`${illustId}_${page}` → { url, w, h }（翻页回看秒开 + 每页宽高比）
  const originalCacheRef = useRef({});
  // 本次详情会话内已自动保存过的 (作品, 页码)，避免 illustData 到达/切换作品时重复触发
  const autoSavedKeysRef = useRef(new Set());

  const isGif = image?.type === 'gif';
  const pageCount = Math.max(
    illustData?.illust?.pageCount || 0,
    illustData?.illust?.images?.length || 0,
    image?._totalPages || 0,
    1,
  );

  // 切换作品时重置详情数据（避免残留上一张作品的画面）
  useEffect(() => {
    setIllustData(null);
    setLightboxIndex(null);
  }, [image?.illustId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 页面原图加载完成 → 记录到 state，供灯箱复用已加载原图
  const handlePageLoaded = useCallback((page, entry) => {
    if (!image?.illustId || !entry) return;
    setLoadedPages(prev => ({ ...prev, [`${image.illustId}_${page}`]: entry }));
  }, [image]);

  // 切换作品时滚回顶部，或指定非首页时滚动到对应页
  useEffect(() => {
    if (!image?.illustId) return;
    const target = image?._pageIndex ?? 0;
    const t = setTimeout(() => {
      if (target > 0) {
        const node = pageRefs.current[target];
        if (node) { node.scrollIntoView({ block: 'start' }); return; }
      }
      contentRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    }, 60);
    return () => clearTimeout(t);
  }, [image?.illustId, image?._pageIndex]);

  // 获取作品详情（所有页共享同一份 API 响应，仅依赖 illustId，不随翻页重复请求）
  useEffect(() => {
    if (!image?.illustId) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await window.api.fetchIllust(image.illustId);
        if (!cancelled) setIllustData(result);
      } catch {
        // fetchIllust 失败 → illustData 保持 null，后续按页从 URL 推导
      }
    })();
    return () => { cancelled = true; };
  }, [image?.illustId]);

  // 按页加载原图：缓存命中 → 本地相册 → illustData URL → URL 推导回退（jpg→png 兜底）
  const loadPageOriginal = useCallback(async (illustId, page) => {
    if (!illustId) return null;
    const cacheKey = `${illustId}_${page}`;
    const cached = originalCacheRef.current[cacheKey];
    if (cached?.url) return cached;

    // 1. 本地相册已有 → 直接读本地原图（全分辨率），跳过网络下载
    if (window.api?.storageFacade?.load) {
      try {
        const local = await window.api.storageFacade.load(illustId, page);
        if (local?.localUrl) {
          const entry = { url: local.localUrl, w: 0, h: 0 };
          originalCacheRef.current[cacheKey] = entry;
          // blob URL 异步探测自然尺寸，用于容器宽高比
          const probe = new Image();
          probe.onload = () => {
            entry.w = probe.naturalWidth;
            entry.h = probe.naturalHeight;
          };
          probe.src = local.localUrl;
          return entry;
        }
      } catch { /* 本地读取失败 → 回退网络下载 */ }
    }

    // 2. 网络图片：必须等 illustData 就绪才能拿到精确的多页 URL
    const imgs = illustData?.illust?.images || [];
    if (!imgs.length) return null; // illustData 未就绪 → 等下次 retry
    const useRegular = getSettingsSync().detailQuality === 'regular';
    const p0 = imgs[0]?.originalUrl || imgs[0]?.url || '';
    const rawUrl = (useRegular ? imgs[page]?.url : imgs[page]?.originalUrl)
      || (p0 ? p0.replace(/_p0\./, `_p${page}.`).replace(/_p0_/, `_p${page}_`) : '');
    if (!rawUrl) return null;

    const loaded = await new Promise(resolve => {
      let settled = false;
      const tryLoad = (url) => {
        if (settled) return;
        const img = new Image();
        img.onload = () => {
          if (settled) return;
          settled = true;
          resolve({ url: proxyThumb(url), w: img.naturalWidth, h: img.naturalHeight });
        };
        img.onerror = () => {
          if (settled) return;
          const pngUrl = url.replace(/\.jpg$/i, '.png');
          if (pngUrl !== url) tryLoad(pngUrl);
          else { settled = true; resolve(null); }
        };
        img.src = proxyThumb(url);
      };
      tryLoad(rawUrl);
    });
    if (loaded) originalCacheRef.current[cacheKey] = loaded;
    return loaded;
  }, [illustData, image?.thumbnailUrl, image?.mediumUrl]);

  // 页面进入视口时自动保存该页（静默，每页本次会话只保存一次）
  const savePage = useCallback(async (page) => {
    if (!image?.illustId) return;
    const saveKey = `${image.illustId}_${page}`;
    if (autoSavedKeysRef.current.has(saveKey)) return;
    const pg = illustData?.illust?.images?.[page] || {};
    const item = {
      illustId: image.illustId,
      _pageIndex: page,
      _silent: true, // 滚动浏览自动保存不弹 toast
      type: image.type,
      originalUrl: pg.originalUrl || image.originalUrl || '',
      mediumUrl: pg.url || image.mediumUrl,
      thumbnailUrl: image.thumbnailUrl,
      title: image.title,
      author: image.author,
      authorName: image.authorName,
    };
    // 没有任何可用地址时不消耗 key：等 illustData 到达后带完整地址重试
    if (!(item.originalUrl || item.mediumUrl || item.thumbnailUrl)) return;
    autoSavedKeysRef.current.add(saveKey);
    if (window.api?.storageFacade?.saveFromNetwork) {
      try {
        const r = await window.api.storageFacade.saveFromNetwork(item);
        if (r?.success) {
          const ck = getCompositeKey(item);
          setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], cached: true, saved: true } }));
        } else if (r?.error === 'gif_not_supported' && window.api?.cachePixivImage) {
          // GIF 走旧下载接口（含 ZIP 解码/GIF 编码）
          const gifRes = await window.api.cachePixivImage(item).catch(() => null);
          if (gifRes?.success || gifRes?.cached) {
            const ck = getCompositeKey(item);
            setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], cached: true, saved: true } }));
          }
        } else {
          // 保存失败（缺地址/下载失败）：释放 key，等下次触发时重试
          autoSavedKeysRef.current.delete(saveKey);
        }
      } catch {
        autoSavedKeysRef.current.delete(saveKey);
      }
    } else {
      window.api.cachePixivImage?.(item).catch(() => {});
    }
  }, [image, illustData, setPixivCache]);

  // GIF 动图进入详情页时自动保存（旧逻辑：看图即缓存动图）
  useEffect(() => {
    if (isGif) savePage(0);
  }, [isGif, savePage]);

  // 卸载时回收本地 blob URL（本地相册读取生成的临时对象）
  useEffect(() => () => {
    Object.values(originalCacheRef.current).forEach(e => {
      if (e?.url?.startsWith('blob:')) URL.revokeObjectURL(e.url);
    });
  }, []);

  // 点♥保存全部页（多图逐页下载，单页即当前页），随后由 LightboxActions 切换喜欢标记
  const handleSaveAllOnLike = useCallback(async () => {
    if (!image?.illustId) return;
    let imgs = illustData?.illust?.images || [];
    let total = pageCount;
    // illustData 未就绪时先拉一次详情，确保拿到完整页数
    if (imgs.length === 0 && window.api?.fetchIllust) {
      try {
        const r = await window.api.fetchIllust(image.illustId);
        imgs = r?.illust?.images || [];
        total = Math.max(r?.illust?.pageCount || 0, imgs.length || 0);
      } catch { /* 保持当前页数 */ }
    }
    total = Math.max(total, image?._totalPages || 1);
    for (let p = 0; p < total; p++) {
      // 跳过已保存的页面（auto-save 已处理当前页，避免重复下载+重复 toast）
      const ck = getCompositeKey({ illustId: image.illustId, _pageIndex: p });
      if (pixivCache[ck]?.saved) continue;
      const pg = imgs[p] || {};
      // 详情接口拿不到该页时，用 illustId 推导 pixiv.re 直链，避免只存缩略图
      const derived = image.illustId ? pixivReUrl(String(image.illustId), p) : '';
      const item = {
        illustId: image.illustId,
        _pageIndex: p,
        _silent: true, // 点♥后台批量保存，不弹 toast
        type: image.type,
        originalUrl: pg.originalUrl || (p === 0 ? image.originalUrl : '') || derived || '',
        mediumUrl: pg.url || (p === 0 ? image.mediumUrl : '') || derived || '',
        thumbnailUrl: image.thumbnailUrl,
        title: image.title,
        author: image.author,
        authorName: image.authorName,
      };
      try {
        if (window.api?.storageFacade?.saveFromNetwork) {
          const r2 = await window.api.storageFacade.saveFromNetwork(item);
          if (r2?.success) {
            setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], cached: true, saved: true } }));
          } else if (r2?.error === 'gif_not_supported' && window.api?.cachePixivImage) {
            const gifRes = await window.api.cachePixivImage(item).catch(() => null);
            if (gifRes?.success || gifRes?.cached) {
              setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], cached: true, saved: true } }));
            }
          }
        } else {
          await window.api.cachePixivImage?.(item).catch(() => {});
        }
      } catch { /* 单页失败不阻塞后续页 */ }
    }
    // 不在结尾弹 "已保存" toast — toggleLike 已经弹了 "❤️ 已喜欢"，避免 toast 轰炸
  }, [image, pageCount, illustData, pixivCache, setPixivCache]);

  // 灯箱媒体项：点击大图弹出全屏预览。
  // 原图未就绪时用当前可见图兜底，保证点击立即有响应；多图作品包含全部页面，支持灯箱内翻页。
  const lightboxMedia = (() => {
    if (!image?.illustId) return [];
    const totalPages = Math.max(pageCount, image?._totalPages || 1);
    const items = [];
    for (let p = 0; p < totalPages; p++) {
      const cached = loadedPages[`${image.illustId}_${p}`];
      const imgs = illustData?.illust?.images || [];
      let fallbackSrc = imgs[p]?.url || imgs[p]?.originalUrl;
      if (!fallbackSrc) {
        const p0 = imgs[0]?.url || imgs[0]?.originalUrl || '';
        fallbackSrc = p0 ? p0.replace(/_p0\./, `_p${p}.`).replace(/_p0_/, `_p${p}_`) : '';
      }
      items.push({
        type: isGif ? 'gif' : 'image',
        src: cached?.url || fallbackSrc,
        illustId: image.illustId,
        _pageIndex: p,
        _totalPages: totalPages,
        _lazy: isGif ? true : undefined,
        title: image?.title || '',
        author: image?.author || '',
        authorId: image?.authorId || '',
        authorName: image?.authorName || image?.author || '',
        pixivUrl: image?.pixivUrl || `https://www.pixiv.net/artworks/${image.illustId}`,
        width: cached?.w || image?.width || 0,
        height: cached?.h || image?.height || 0,
        thumbnailUrl: image?.thumbnailUrl || pixivReUrl(String(image.illustId), 0, 'thumb'),
      });
    }
    return items;
  })();

  const renderLightboxActions = useCallback((cur) => (
    <LightboxActions
      scene="search"
      cur={cur}
      pixivCache={pixivCache}
      setPixivCache={setPixivCache}
      onAuthorWorks={onAuthorWorks}
      onLikeSaveAll={handleSaveAllOnLike}
    />
  ), [pixivCache, setPixivCache, onAuthorWorks, handleSaveAllOnLike]);

  // 灯箱打开时注册返回处理（关闭灯箱，不回退到详情栈）
  useEffect(() => {
    if (lightboxIndex === null) return;
    return registerBackHandler(() => {
      setLightboxIndex(null);
      return true;
    });
  }, [lightboxIndex]);

  // 加载相关推荐
  useEffect(() => {
    if (!image?.illustId) return;
    let cancelled = false;
    (async () => {
      setRelated([]);
      setLoadingRelated(true);
      try {
        const result = await window.api.fetchRelated(image.illustId, { limit: 30 });
        if (cancelled) return;
        const rawList = result?.illusts || [];
        if (rawList.length > 0) {
          setRelated(parsePixivResults(rawList));
        }
      } catch (e) {
        if (cancelled) return;
        console.warn('[ImageDetail] fetchRelated failed:', e);
      }
      if (!cancelled) setLoadingRelated(false);
    })();
    return () => { cancelled = true; };
  }, [image?.illustId]);

  return (
    <div className="char-state-bar">
      {/* 顶部栏 — 仅返回按钮 */}
      <PageHeader title="图片详情" onBack={onBack} />

      <div className="char-state-content" ref={contentRef}>
        {/* GIF 动图：用动图播放器 */}
        {isGif ? (
          <div style={{ display: 'flex', justifyContent: 'center' }} onClick={() => setLightboxIndex(0)}>
            <UgoiraPlayer
              illustId={image?.illustId}
              title={image?.title}
              author={image?.authorName || image?.author}
              pixivUrl={image?.pixivUrl}
              thumbnailUrl={image?.thumbnailUrl}
              _lazy
            />
          </div>
        ) : (
          <>
            {/* 全部页面上下堆叠：进入视口懒加载原图，滚到哪看到哪 */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {Array.from({ length: pageCount }, (_, p) => (
                <DetailPageBlock
                  key={`${image.illustId}-${p}`}
                  page={p}
                  image={image}
                  rootRef={contentRef}
                  registerRef={(page, node) => { pageRefs.current[page] = node; }}
                  loadOriginal={loadPageOriginal}
                  onSavePage={savePage}
                  onPageLoaded={handlePageLoaded}
                  onOpenLightbox={(page) => setLightboxIndex(page)}
                  illustDataReady={illustData !== null}
                />
              ))}
            </div>
          </>
        )}

        {/* 操作栏 */}
        <div style={{ padding: '8px 12px' }}>
          <LightboxActions
            scene="search"
            cur={image}
            pixivCache={pixivCache}
            setPixivCache={setPixivCache}
            onAuthorWorks={onAuthorWorks}
            onLikeSaveAll={handleSaveAllOnLike}
            noLike
          />
        </div>

        {/* 分隔 + 相关推荐标题 */}
        <div className="image-detail-section-header">
          <span className="image-detail-section-title">相关推荐</span>
          {loadingRelated && <span className="image-detail-section-loading">加载中...</span>}
        </div>

        {/* 相关推荐网格 */}
        {!loadingRelated && related.length > 0 && (
          <div className="pixiv-grid">
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
                        <span className="gif-badge">GIF</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!loadingRelated && related.length === 0 && (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--color-text-secondary)', fontSize: 13 }}>
            暂无相关推荐
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
          renderActions={renderLightboxActions}
          zIndex={10000}
        />
      )}

      {/* 喜欢按钮 — 左下角悬浮 */}
      <div className="detail-floating-like">
        <LikeButton
          cur={image}
          pixivCache={pixivCache}
          setPixivCache={setPixivCache}
          onLikeSaveAll={handleSaveAllOnLike}
        />
      </div>
    </div>
  );
}

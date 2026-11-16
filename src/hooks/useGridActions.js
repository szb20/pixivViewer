import { useCallback } from 'react';
import { getCompositeKey, sourceOfId, storageFacade } from '../pixiv-assistant/index.js';
import { usePixivCacheSetter } from '../context/pixivCacheContext.js';
import { showToast } from '../utils/toast.js';
import { buildLikeMeta } from '../utils/likeMeta.js';
import { saveAllPages } from '../api/saveAllPages.js';
import { syncBookmark } from '../api/bookmarkSync.js';

/**
 * useGridActions — 网格卡片上两个相互独立的动作：
 * - toggleLike：左下角红心点按，只切喜欢（本地落库 + 远端收藏同步），不触发下载
 * - downloadAll：长按 = 喜欢 + 下载全部页（pixiv/X 多页逐页保存、动图走帧通道）。
 *   喜欢对所有作品只做加法（未喜欢才落库，已喜欢不重复；取消喜欢走红心按钮）
 *
 * 主网格（ImageGrid）与详情页"更多推荐"共用同一套逻辑。
 *
 * 只订阅永不变的写侧 context（值经 getPixivCache() 现场取）：
 * 多页下载逐页落库不再让全网格壳层随 pixivCache 变化重渲染。
 *
 * @returns {{
 *   toggleLike: (img: object) => Promise<void>,
 *   downloadAll: (img: object) => Promise<void>,
 * }}
 */
export function useGridActions() {
  const { setPixivCache, getPixivCache } = usePixivCacheSetter();

  const toggleLike = useCallback(async (img) => {
    if (!img?.illustId) return;
    const ck = getCompositeKey({ illustId: String(img.illustId), _pageIndex: img._pageIndex ?? 0 });
    // 组合态：远端已收藏但本地未点（如收藏 tab 列表项带 _bookmarked）→ 点按应视为「取消」而非「喜欢」
    const cache = getPixivCache();
    const localLiked = !!cache[ck]?.liked;
    const prevLiked = localLiked || !!img._bookmarked || !!img.bookmarked;
    const targetLiked = !prevLiked;
    setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: targetLiked, likedAt: Date.now() } }));
    let likedOk = false;
    let toggleOk = false;
    try {
      let result;
      if (!targetLiked && !localLiked) {
        // 组合态取消：本地无记录，unlike 幂等安全（toggleLike 会误建记录置 liked）
        result = await storageFacade.unlike(String(img.illustId), img._pageIndex ?? 0);
      } else {
        result = await storageFacade.toggleLike(String(img.illustId), img._pageIndex ?? 0, buildLikeMeta(img));
      }
      toggleOk = !!result?.success;
      if (toggleOk) {
        likedOk = targetLiked;
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: targetLiked, likedAt: targetLiked ? (result.likedAt || Date.now()) : 0 } }));
        showToast(targetLiked ? '已喜欢' : '已取消喜欢', { type: 'success' });
      } else {
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
        showToast('操作失败', { type: 'error' });
      }
    } catch {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      showToast('操作失败', { type: 'error' });
    }
    window.dispatchEvent(new CustomEvent('pixiv:liked-changed'));

    // 远端收藏同步（fire-and-forget，不阻塞；booru/未登录由 syncBookmark 内部跳过）。
    // 多页治理：取消时若同作品还有其他 liked 页，不删远端收藏；喜欢任意页都触发收藏（幂等）。
    if (toggleOk) {
      const otherPageLiked = Object.entries(getPixivCache())
        .some(([k, v]) => k !== ck && k.startsWith(`${String(img.illustId)}_`) && v?.liked);
      if (likedOk || !otherPageLiked) {
        void syncBookmark({
          illustId: img.illustId,
          source: img.source || sourceOfId(img.illustId),
          targetLiked: likedOk,
        });
      }
    }
  }, [setPixivCache, getPixivCache]);

  const downloadAll = useCallback(async (img) => {
    if (!img?.illustId) return;
    const ck = getCompositeKey({ illustId: String(img.illustId), _pageIndex: img._pageIndex ?? 0 });
    const source = img.source || sourceOfId(img.illustId);
    // 单页 booru post 走单条保存；pixiv / X 的多页作品与动图走 saveAllPages 逐页下载。
    // （旧长按把非 pixiv 一律钳到单条保存，X 的多图推文只能下到第一张。）
    const totalPages = Math.max(
      Number(img._totalPages || img.pageCount) || 0,
      Array.isArray(img._pages) ? img._pages.length : 0,
      1,
    );
    // 长按 = 喜欢 + 下载全部（对所有作品生效）：喜欢只做加法（未喜欢才落库 + 同步远端收藏），
    // 已喜欢的只下载不重复点赞；取消喜欢始终走红心按钮，长按永远不会 unlike。
    let likedNow = false;
    const alreadyLiked = !!getPixivCache()[ck]?.liked || !!img._bookmarked || !!img.bookmarked;
    if (!alreadyLiked) {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: true, likedAt: Date.now() } }));
      try {
        const result = await storageFacade.toggleLike(String(img.illustId), img._pageIndex ?? 0, buildLikeMeta(img));
        if (result?.success) {
          likedNow = true;
          window.dispatchEvent(new CustomEvent('pixiv:liked-changed'));
          // 远端收藏同步（fire-and-forget；booru/未登录由 syncBookmark 内部跳过）
          void syncBookmark({ illustId: img.illustId, source, targetLiked: true });
        } else {
          setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: false } }));
        }
      } catch {
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: false } }));
      }
    }
    const likePrefix = likedNow ? '已喜欢，' : '';

    if (source !== 'pixiv' && img.type !== 'gif' && totalPages <= 1) {
      let r = null;
      try {
        const { saveSingleItem } = await import('../api/saveSingle.js');
        r = await saveSingleItem({ ...img, source, _silent: true });
      } catch {
        showToast(likedNow ? '已喜欢，保存到相册失败' : '保存到相册失败', { type: 'error' });
        return;
      }
      if (r?.success || r?.cached) {
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], cached: true, saved: true } }));
        showToast(`${likePrefix}${r?.idempotent || r?.skipped ? '已在相册中' : '已保存到相册'}`, { type: 'success' });
      } else {
        showToast(likedNow ? '已喜欢，保存到相册失败' : '保存到相册失败', { type: 'warning' });
      }
      return;
    }
    // pixivCache 要传下去：saveAllPages 靠它跳过已经保存过的页（不传就每页白跑一遍保存链路）
    const { saved, exists } = await saveAllPages(img, { pixivCache: getPixivCache(), setPixivCache });
    if (saved > 0 && exists > 0) showToast(`${likePrefix}已保存 ${saved} 页到相册，${exists} 页已存在`, { type: 'success' });
    else if (saved > 0) showToast(`${likePrefix}已保存 ${saved} 页到相册`, { type: 'success' });
    else if (exists > 0) showToast(likedNow ? '已喜欢，已在相册中' : '已在相册中', { type: 'info' });
    else showToast(likedNow ? '已喜欢，下载失败' : '下载失败', { type: 'error' });
  }, [setPixivCache, getPixivCache]);

  return { toggleLike, downloadAll };
}

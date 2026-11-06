import { useCallback } from 'react';
import { getCompositeKey, sourceOfId, storageFacade } from '../pixiv-assistant/index.js';
import { usePixivCacheSetter } from '../context/pixivCacheContext.js';
import { showToast } from '../utils/toast.js';
import { buildLikeMeta } from '../utils/likeMeta.js';
import { saveAllPages } from '../api/saveAllPages.js';
import { syncBookmark } from '../api/bookmarkSync.js';

/**
 * 网格长按 → 切换喜欢；喜欢成功后下载全部页到相册（失败不下载）。
 * 主网格（ImageGrid）与详情页"更多推荐"共用同一套逻辑。
 *
 * 只订阅永不变的写侧 context（值经 getPixivCache() 现场取）：
 * 多页下载逐页落库不再让全网格壳层随 pixivCache 变化重渲染。
 *
 * @returns {(img: object) => Promise<void>} toggleLike
 */
export function useGridLikeToggle() {
  const { setPixivCache, getPixivCache } = usePixivCacheSetter();

  const toggleLike = useCallback(async (img) => {
    if (!img?.illustId) return;
    const ck = getCompositeKey({ illustId: String(img.illustId), _pageIndex: img._pageIndex ?? 0 });
    // 组合态：远端已收藏但本地未点（如收藏 tab 列表项带 _bookmarked）→ 长按应视为「取消」而非「喜欢」
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
        // 「已喜欢」不单独弹：喜欢的反馈与随后的保存结果合并成一条 toast（见下方保存分支）
        if (!targetLiked) showToast('已取消喜欢', { type: 'success' });
      } else {
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      }
    } catch {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
    }
    window.dispatchEvent(new CustomEvent('pixiv:liked-changed'));

    // 远端收藏同步（fire-and-forget，不阻塞下载；booru/未登录由 syncBookmark 内部跳过）。
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

    // 只有喜欢真的成功（且是"喜欢"而非"取消"）才下载
    if (!likedOk) return;
    // 动图走帧序列通道，与静态图分开（booru 无动图，此分支只可能命中 pixiv）
    if (img.source && img.source !== 'pixiv' && img.type !== 'gif') {
      let r = null;
      try {
        const { saveSingleItem } = await import('../api/saveSingle.js');
        r = await saveSingleItem({ ...img, source: img.source || sourceOfId(img.illustId), _silent: true });
      } catch {
        // 喜欢/下载是两个独立动作：保存失败不回滚红心，合并提示
        showToast('已喜欢，保存到相册失败', { type: 'error' });
        return;
      }
      if (r?.success || r?.cached) {
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], cached: true, saved: true } }));
        showToast(`已喜欢，${r?.idempotent || r?.skipped ? '已在相册中' : '已保存到相册'}`, { type: 'success' });
      } else {
        showToast('已喜欢，保存到相册失败', { type: 'warning' });
      }
      return;
    }
    // pixivCache 要传下去：saveAllPages 靠它跳过已经保存过的页（不传就每页白跑一遍保存链路）
    const { saved, exists } = await saveAllPages(img, { pixivCache: getPixivCache(), setPixivCache });
    if (saved > 0 && exists > 0) showToast(`已喜欢，已保存 ${saved} 页到相册，${exists} 页已存在`, { type: 'success' });
    else if (saved > 0) showToast(`已喜欢，已保存 ${saved} 页到相册`, { type: 'success' });
    else if (exists > 0) showToast('已喜欢，已在相册中', { type: 'info' });
    else showToast('已喜欢，但保存失败', { type: 'error' });
  }, [setPixivCache, getPixivCache]);

  return toggleLike;
}

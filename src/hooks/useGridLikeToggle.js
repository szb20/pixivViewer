import { useCallback } from 'react';
import { getCompositeKey } from '../pixiv-assistant/core/utils.js';
import { storageFacade } from '../pixiv-assistant/index.js';
import { usePixivCache } from '../context/pixivCacheContext.js';
import { showToast } from '../utils/toast.js';
import { buildLikeMeta } from '../utils/likeMeta.js';
import { saveAllPages } from '../api/saveAllPages.js';

/**
 * 网格长按 → 切换喜欢；喜欢成功后下载全部页到相册（失败不下载）。
 * 主网格（ImageGrid）与详情页"更多推荐"共用同一套逻辑。
 *
 * @returns {(img: object) => Promise<void>} toggleLike
 */
export function useGridLikeToggle() {
  const { setPixivCache } = usePixivCache();

  const toggleLike = useCallback(async (img) => {
    if (!img?.illustId) return;
    const ck = getCompositeKey({ illustId: String(img.illustId), _pageIndex: img._pageIndex ?? 0 });
    let prevLiked = false;
    setPixivCache(prev => {
      prevLiked = !!prev[ck]?.liked;
      return { ...prev, [ck]: { ...prev[ck], liked: !prevLiked, likedAt: Date.now() } };
    });
    let likedOk = false;
    try {
      const result = await storageFacade.toggleLike(String(img.illustId), img._pageIndex ?? 0, buildLikeMeta(img));
      if (result.success) {
        likedOk = result.liked;
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: result.liked, likedAt: result.likedAt } }));
        showToast(result.liked ? '已喜欢' : '已取消喜欢', { type: 'success' });
      } else {
        setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      }
    } catch {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
    }
    window.dispatchEvent(new CustomEvent('pixiv:liked-changed'));

    // 只有喜欢真的成功（且是"喜欢"而非"取消"）才下载全部页
    if (!likedOk) return;
    const { saved, exists } = await saveAllPages(img, { setPixivCache });
    if (saved > 0 && exists > 0) showToast(`已保存 ${saved} 页到相册，${exists} 页已存在`, { type: 'success' });
    else if (saved > 0) showToast(`已保存 ${saved} 页到相册`, { type: 'success' });
    else if (exists > 0) showToast('已在相册中', { type: 'info' });
  }, [setPixivCache]);

  return toggleLike;
}

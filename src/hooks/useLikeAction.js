import { useCallback, useRef } from 'react';
import { getCompositeKey } from '../pixiv-assistant/core/utils.js';
import { storageFacade } from '../pixiv-assistant/index.js';
import { usePixivCache } from '../context/pixivCacheContext.js';
import { showToast } from '../utils/toast.js';
import { buildLikeMeta } from '../utils/likeMeta.js';

/**
 * useLikeAction — 统一的"喜欢"逻辑：
 * - 点按：切换喜欢；单图/GIF 顺带保存（喜欢=下载）；多图只切喜欢不下载
 * - 长按：切换喜欢 + 下载全部页
 *
 * 详情页 LikeButton 与 grid 封面 ♥ 共用同一套逻辑。
 *
 * @param {object} cur  当前作品条目
 * @param {object} opts
 * @param {function} [opts.onLikeSaveAll] (item) => Promise<{saved, exists}> 保存全部页（不含 toast，由本 hook 汇总提示）
 * @param {number|string} [opts.totalPages] 总页数（缺省从条目推导）
 */
export function useLikeAction(cur, { onLikeSaveAll, totalPages } = {}) {
  const { pixivCache, setPixivCache } = usePixivCache();
  const liked = cur?.illustId
    ? (pixivCache[getCompositeKey(cur)]?.liked || cur._liked || false)
    : false;
  const multiPage = (Number(totalPages) || Number(cur?._totalPages) || Number(cur?.pageCount) || 1) > 1;
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);

  const notifyLikedChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent('pixiv:liked-changed'));
  }, []);

  const handleLike = useCallback(async (e) => {
    // 长按已触发下载，本次合成的 click 不再切换喜欢
    if (longPressTriggeredRef.current) { longPressTriggeredRef.current = false; return; }
    e?.stopPropagation?.();
    if (!cur?.illustId) return;
    const ck = getCompositeKey(cur);
    const prevLiked = pixivCache[ck]?.liked || cur._liked || false;
    setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: !prevLiked, likedAt: Date.now() } }));

    if (typeof storageFacade.toggleLike !== 'function') {
      showToast('当前平台暂不支持喜欢功能', { type: 'warning' });
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      return;
    }

    let result;
    try {
      result = await storageFacade.toggleLike(cur.illustId, cur._pageIndex ?? 0, buildLikeMeta(cur));
    } catch {
      showToast('操作失败', { type: 'error' });
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      return;
    }
    if (result.success) {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: result.liked, likedAt: result.likedAt } }));
      notifyLikedChanged();
    } else {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      showToast('操作失败', { type: 'error' });
      return;
    }

    // 单图 / GIF：喜欢 = 下载；多图：喜欢只是喜欢，下载走长按
    if (result.liked && !multiPage && typeof onLikeSaveAll === 'function') {
      onLikeSaveAll(cur).then((res) => {
        const saved = Number(res?.saved ?? res) || 0;
        const exists = Number(res?.exists) || 0;
        if (saved > 0 && exists > 0) showToast(`已保存 ${saved} 页到相册，${exists} 页已存在`, { type: 'success' });
        else if (saved > 0) showToast(`已保存 ${saved} 页到相册`, { type: 'success' });
        else if (exists > 0) showToast('已在相册中', { type: 'info' });
        else showToast('下载失败', { type: 'error' });
      }).catch(() => {});
    }
  }, [cur, pixivCache, setPixivCache, onLikeSaveAll, multiPage, notifyLikedChanged]);

  // 长按 → 切换喜欢 + 下载全部页
  const handleLongPressSaveAll = useCallback(async () => {
    if (!cur?.illustId) return;
    const ck = getCompositeKey(cur);
    const prevLiked = pixivCache[ck]?.liked || cur._liked || false;
    if (!prevLiked) {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: true, likedAt: Date.now() } }));
      if (typeof storageFacade.toggleLike === 'function') {
        try {
          const result = await storageFacade.toggleLike(cur.illustId, cur._pageIndex ?? 0, buildLikeMeta(cur));
          if (result.success) {
            setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: result.liked, likedAt: result.likedAt } }));
            notifyLikedChanged();
          } else {
            setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
          }
        } catch {
          setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
        }
      }
    }
    if (typeof onLikeSaveAll !== 'function') {
      showToast('当前平台暂不支持下载', { type: 'warning' });
      return;
    }
    const res = await onLikeSaveAll(cur).catch(() => null);
    const saved = Number(res?.saved ?? res) || 0;
    const exists = Number(res?.exists) || 0;
    if (saved > 0 && exists > 0) showToast(`已保存 ${saved} 页到相册，${exists} 页已存在`, { type: 'success' });
    else if (saved > 0) showToast(`已保存 ${saved} 页到相册`, { type: 'success' });
    else if (exists > 0) showToast('已在相册中', { type: 'info' });
    else showToast('下载失败', { type: 'error' });
  }, [cur, pixivCache, setPixivCache, onLikeSaveAll, notifyLikedChanged]);

  const startLongPress = useCallback((e) => {
    e?.stopPropagation?.();
    if (e?.pointerType === 'mouse' && e?.button !== 0) return;
    longPressTriggeredRef.current = false;
    clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      handleLongPressSaveAll();
    }, 500);
  }, [handleLongPressSaveAll]);

  const cancelLongPress = useCallback(() => {
    clearTimeout(longPressTimerRef.current);
  }, []);

  return { liked, multiPage, handleLike, handleLongPressSaveAll, startLongPress, cancelLongPress, longPressTriggeredRef };
}

import { useCallback, useEffect, useRef } from 'react';
import { getCompositeKey, sourceOfId, storageFacade } from '../pixiv-assistant/index.js';
import { usePixivCache, usePixivCacheSetter } from '../context/pixivCacheContext.js';
import { showToast } from '../utils/toast.js';
import { buildLikeMeta } from '../utils/likeMeta.js';
import { syncBookmark } from '../api/bookmarkSync.js';

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
  const { pixivCache } = usePixivCache();
  const { setPixivCache } = usePixivCacheSetter();
  // 红心显示 = 本地喜欢 || 远端已收藏（详情接口带 bookmarkData，与红心同步联动）。
  // _bookmarked 是收藏夹面板注入的「远端已收藏但本地未点」标记，需一并认账，
  // 否则详情页红心语义与网格（全亮）相反
  const liked = cur?.illustId
    ? (pixivCache[getCompositeKey(cur)]?.liked || cur._liked || cur.bookmarked || cur._bookmarked || false)
    : false;
  const multiPage = (Number(totalPages) || Number(cur?._totalPages) || Number(cur?.pageCount) || 1) > 1;
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);

  // 卸载时丢掉未触发的长按：500ms 窗口内切换作品/关灯箱，
  // 不该在别的界面上弹出「保存全部」的下载与提示。
  useEffect(() => () => clearTimeout(longPressTimerRef.current), []);

  const notifyLikedChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent('pixiv:liked-changed'));
  }, []);

  const handleLike = useCallback(async (e) => {
    // 长按已触发下载，本次合成的 click 不再切换喜欢
    if (longPressTriggeredRef.current) { longPressTriggeredRef.current = false; return; }
    e?.stopPropagation?.();
    if (!cur?.illustId) return;
    const ck = getCompositeKey(cur);
    const prevLiked = pixivCache[ck]?.liked || cur._liked || cur.bookmarked || cur._bookmarked || false;
    const targetLiked = !prevLiked;
    setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: targetLiked, likedAt: Date.now() } }));

    if (typeof storageFacade.like !== 'function' || typeof storageFacade.unlike !== 'function') {
      showToast('当前平台暂不支持喜欢功能', { type: 'warning' });
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      return;
    }

    let result;
    try {
      result = targetLiked
        ? await storageFacade.like(cur.illustId, cur._pageIndex ?? 0, buildLikeMeta(cur))
        : await storageFacade.unlike(cur.illustId, cur._pageIndex ?? 0);
    } catch {
      showToast('操作失败', { type: 'error' });
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      return;
    }
    if (result.success) {
      const likedAt = targetLiked ? (result.likedAt || Date.now()) : 0;
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: targetLiked, likedAt } }));
      notifyLikedChanged();
      // 远端收藏同步（fire-and-forget；booru/未登录由 syncBookmark 内部跳过）
      void syncBookmark({
        illustId: cur.illustId,
        source: cur.source || sourceOfId(cur.illustId),
        targetLiked,
      });
    } else {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      showToast('操作失败', { type: 'error' });
      return;
    }

    // 单图 / GIF：喜欢 = 下载；多图：喜欢只是喜欢，下载走长按
    if (targetLiked && !multiPage && typeof onLikeSaveAll === 'function') {
      onLikeSaveAll(cur).then((res) => {
        const saved = Number(res?.saved ?? res) || 0;
        const exists = Number(res?.exists) || 0;
        if (saved > 0 && exists > 0) showToast(`已保存 ${saved} 页到相册，${exists} 页已存在`, { type: 'success' });
        else if (saved > 0) showToast(`已保存 ${saved} 页到相册`, { type: 'success' });
        else if (exists > 0) showToast('已在相册中', { type: 'info' });
        else showToast('下载失败', { type: 'error' });
      }).catch(() => { });
    }
  }, [cur, pixivCache, setPixivCache, onLikeSaveAll, multiPage, notifyLikedChanged]);

  // 长按 → 未喜欢则先标记喜欢 + 下载全部页（已喜欢时仅下载，不取消喜欢）
  const handleLongPressSaveAll = useCallback(async () => {
    if (!cur?.illustId) return;
    const ck = getCompositeKey(cur);
    const localLiked = pixivCache[ck]?.liked || cur._liked || false;
    // 组合态（远端已收藏但本地未点）长按时补本地落库 + 幂等远端收藏，网格红心随之持久化
    if (!localLiked) {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: true, likedAt: Date.now() } }));
      if (typeof storageFacade.like === 'function') {
        try {
          const result = await storageFacade.like(cur.illustId, cur._pageIndex ?? 0, buildLikeMeta(cur));
          if (result.success) {
            setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: true, likedAt: result.likedAt || Date.now() } }));
            notifyLikedChanged();
            // 长按只喜欢不取消 → 只同步收藏（fire-and-forget）
            void syncBookmark({
              illustId: cur.illustId,
              source: cur.source || sourceOfId(cur.illustId),
              targetLiked: true,
            });
          } else {
            setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: localLiked } }));
          }
        } catch {
          setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: localLiked } }));
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

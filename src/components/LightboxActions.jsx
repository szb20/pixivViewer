/**
 * LikeButton — 喜欢按钮（灯箱左下角/详情页悬浮）。
 *
 * 交互：
 * - 点按：切换喜欢；单图/GIF 会顺带保存（喜欢=下载）；多图只切喜欢不下载
 * - 长按：切换喜欢 + 下载全部页（图标会同步切换）
 *
 * 缓存状态（pixivCache/setPixivCache/likedSet）统一取自 PixivCacheContext，
 * 不再由父组件逐层穿透。
 */

import React, { useCallback, useRef } from 'react';
import { getCompositeKey } from '../pixiv-assistant/core/utils.js';
import { storageFacade } from '../pixiv-assistant/index.js';
import { usePixivCache } from '../context/pixivCacheContext.js';
import { showToast } from '../utils/toast.js';
import HeartIcon from './icons/HeartIcon.jsx';

export function LikeButton({ cur, onLikeSaveAll, totalPages }) {
  const { pixivCache, setPixivCache } = usePixivCache();
  const liked = cur?.illustId
    ? (pixivCache[getCompositeKey(cur)]?.liked || cur._liked || false)
    : false;
  const multiPage = (Number(totalPages) || Number(cur?._totalPages) || Number(cur?.pageCount) || 1) > 1;
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);

  // 点赞成功后广播，通知收藏等页面刷新
  const notifyLikedChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent('pixiv:liked-changed'));
  }, []);

  const handleLike = useCallback(async (e) => {
    // 长按已触发下载，本次合成的 click 不再切换喜欢
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    e.stopPropagation();
    if (!cur?.illustId) return;
    const ck = getCompositeKey(cur);
    const prevLiked = pixivCache[ck]?.liked || cur._liked || false;
    setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: !prevLiked, likedAt: Date.now() } }));

    if (typeof storageFacade.toggleLike !== 'function') {
      showToast('当前平台暂不支持喜欢功能');
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      return;
    }

    let result;
    try {
      result = await storageFacade.toggleLike(cur.illustId, cur._pageIndex ?? 0);
    } catch {
      showToast('操作失败');
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      return;
    }
    if (result.success) {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: result.liked, likedAt: result.likedAt } }));
      notifyLikedChanged();
    } else {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      showToast('操作失败');
      return;
    }

    // 单图 / GIF：喜欢 = 下载；多图：喜欢只是喜欢，下载走长按或灯箱按钮
    if (result.liked && !multiPage && typeof onLikeSaveAll === 'function') {
      onLikeSaveAll(cur).catch(() => {});
    }
  }, [cur, pixivCache, setPixivCache, onLikeSaveAll, multiPage, notifyLikedChanged]);

  // 长按 → 切换喜欢 + 下载全部页
  const handleLongPressSaveAll = useCallback(async () => {
    if (!cur?.illustId) return;
    // 先切换喜欢
    const ck = getCompositeKey(cur);
    const prevLiked = pixivCache[ck]?.liked || cur._liked || false;
    if (!prevLiked) {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: true, likedAt: Date.now() } }));
      if (typeof storageFacade.toggleLike === 'function') {
        try {
          const result = await storageFacade.toggleLike(cur.illustId, cur._pageIndex ?? 0);
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
    // 再下载全部页
    if (typeof onLikeSaveAll !== 'function') {
      showToast('当前平台暂不支持下载');
      return;
    }
    const count = await onLikeSaveAll(cur).catch(() => 0);
    showToast(count > 0 ? `已保存 ${count} 页到相册` : '已在相册中');
  }, [cur, pixivCache, setPixivCache, onLikeSaveAll, notifyLikedChanged]);

  const startLongPress = useCallback((e) => {
    e.stopPropagation();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
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

  if (!cur?.illustId) return null;

  return (
    <button
      className="lightbox-dl-btn lightbox-icon-only frosted-light"
      onClick={handleLike}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      title={multiPage ? '点按喜欢；长按喜欢+下载全部页' : '喜欢并保存'}
    >
      <HeartIcon filled className={liked ? 'heart-icon--liked' : 'heart-icon--neutral'} />
    </button>
  );
}

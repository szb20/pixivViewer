/**
 * 灯箱操作按钮 — 统一管理所有场景的底部按钮。
 *
 * Props:
 *   scene         — 'chat' | 'search' | 'gallery'
 *   cur           — 当前灯箱条目
 *   pixivCache    — 缓存状态 { [compositeKey]: { liked, ... } }
 *   setPixivCache — 更新缓存状态
 *   onDelete      — (cur, index) => void   (gallery 场景)
 *   onAuthorWorks — (authorId, authorName) => void   (search 场景)
 *   onLikeSaveAll — async (cur) => void   点♥前的额外处理（如多图保存全部页），可选
 *   index         — 当前索引 (gallery 场景删除用)
 */

import React, { useCallback, useRef } from 'react';
import { getCompositeKey } from '../pixiv-assistant/core/utils.js';
import { showToast } from '../utils/toast.js';
import HeartIcon from './icons/HeartIcon.jsx';

/** 各场景显示的按钮 */
const SCENE = {
  chat:    { like: true, author: false, pixiv: true, delete: false },
  search:  { like: true, author: true,  pixiv: true, delete: false },
  gallery: { like: true, author: false, pixiv: true, delete: true  },
};

/**
 * 喜欢按钮 — 独立导出，用于灯箱左下角悬浮。
 *
 * 交互：
 * - 点按：切换喜欢；单图/GIF 会顺带保存（喜欢=下载）；多图只切喜欢不下载
 * - 长按：切换喜欢 + 下载全部页（图标会同步切换）
 */
export function LikeButton({ cur, pixivCache, setPixivCache, onLikeSaveAll, totalPages }) {
  const liked = cur?.illustId
    ? (pixivCache[getCompositeKey(cur)]?.liked || cur._liked || false)
    : false;
  const multiPage = (Number(totalPages) || Number(cur?._totalPages) || Number(cur?.pageCount) || 1) > 1;
  const longPressTimerRef = useRef(null);
  const longPressTriggeredRef = useRef(false);

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

    const sf = window.api?.storageFacade;
    const toggle = sf?.toggleLike?.bind(sf) || window.api?.toggleLike;
    if (typeof toggle !== 'function') {
      showToast('当前平台暂不支持喜欢功能');
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      return;
    }

    let result;
    try {
      result = await toggle(cur.illustId, cur._pageIndex ?? 0);
    } catch {
      showToast('操作失败');
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      return;
    }
    if (result.success) {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: result.liked, likedAt: result.likedAt } }));
    } else {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      showToast('操作失败');
      return;
    }

    // 单图 / GIF：喜欢=下载；多图：喜欢只是喜欢，下载走长按或灯箱按钮
    if (result.liked && !multiPage && typeof onLikeSaveAll === 'function') {
      onLikeSaveAll(cur).catch(() => {});
    }
  }, [cur, pixivCache, setPixivCache, onLikeSaveAll, multiPage]);

  // 长按 → 切换喜欢 + 下载全部页
  const handleLongPressSaveAll = useCallback(async () => {
    if (!cur?.illustId) return;
    // 先切换喜欢
    const ck = getCompositeKey(cur);
    const prevLiked = pixivCache[ck]?.liked || cur._liked || false;
    if (!prevLiked) {
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: true, likedAt: Date.now() } }));
      const sf = window.api?.storageFacade;
      const toggle = sf?.toggleLike?.bind(sf) || window.api?.toggleLike;
      if (typeof toggle === 'function') {
        try {
          const result = await toggle(cur.illustId, cur._pageIndex ?? 0);
          if (result.success) {
            setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: result.liked, likedAt: result.likedAt } }));
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
  }, [cur, pixivCache, setPixivCache, onLikeSaveAll]);

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
      className="lightbox-dl-btn lightbox-icon-only"
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

export default function LightboxActions({
  scene = 'chat',
  cur,
  pixivCache,
  setPixivCache,
  onDelete,
  onAuthorWorks,
  onLikeSaveAll,
  index,
  noLike = false,
}) {
  const cfg = SCENE[scene] || SCENE.chat;

  const handleAuthor = useCallback((e) => {
    e.stopPropagation();
    if (cur?.authorId && cur?.authorName && onAuthorWorks) {
      onAuthorWorks(cur.authorId, cur.authorName);
    }
  }, [cur, onAuthorWorks]);

  if (!cur) return null;

  return (
    <>
      {/* 喜欢 */}
      {!noLike && cfg.like && cur.illustId && (
        <LikeButton cur={cur} pixivCache={pixivCache} setPixivCache={setPixivCache} onLikeSaveAll={onLikeSaveAll} />
      )}

      {/* 作者作品 */}
      {cfg.author && cur.authorId && cur.authorName && onAuthorWorks && (
        <button className="lightbox-dl-btn" onClick={handleAuthor}
          style={{ color: '#60a5fa' }}>@{cur.authorName}</button>
      )}

      {/* Pixiv 链接 */}
      {cfg.pixiv && cur.pixivUrl && (
        <a className="lightbox-link" href={cur.pixivUrl} target="_blank" rel="noreferrer"
          onClick={e => e.stopPropagation()}>Pixiv</a>
      )}

      {/* 删除（本地相册） */}
      {cfg.delete && onDelete && (
        <button className="lightbox-dl-btn"
          onClick={(e) => { e.stopPropagation(); onDelete(cur, index); }}
          style={{ color: '#ff6b6b' }}>
          删除
        </button>
      )}
    </>
  );
}

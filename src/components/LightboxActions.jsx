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

import React, { useCallback } from 'react';
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
 */
export function LikeButton({ cur, pixivCache, setPixivCache, onLikeSaveAll }) {
  const liked = cur?.illustId
    ? (pixivCache[getCompositeKey(cur)]?.liked || cur._liked || false)
    : false;

  const handleLike = useCallback(async (e) => {
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

    if (result.liked && typeof onLikeSaveAll === 'function') {
      onLikeSaveAll(cur).catch(() => {});
    }
  }, [cur, pixivCache, setPixivCache, onLikeSaveAll]);

  if (!cur?.illustId) return null;

  return (
    <button className="lightbox-dl-btn lightbox-icon-only" onClick={handleLike}>
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

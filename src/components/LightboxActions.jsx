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

export default function LightboxActions({
  scene = 'chat',
  cur,
  pixivCache,
  setPixivCache,
  onDelete,
  onAuthorWorks,
  onLikeSaveAll,
  index,
}) {
  const cfg = SCENE[scene] || SCENE.chat;

  // 喜欢状态：优先读取实时 pixivCache，回退条目自带的 _liked（初始快照）
  const liked = cur?.illustId
    ? (pixivCache[getCompositeKey(cur)]?.liked || cur._liked || false)
    : false;

  const handleLike = useCallback(async (e) => {
    e.stopPropagation();
    if (!cur?.illustId) return;
    const ck = getCompositeKey(cur);
    const prevLiked = pixivCache[ck]?.liked || cur._liked || false;
    // 乐观更新：立刻切换图标颜色，不等异步操作
    setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: !prevLiked, likedAt: Date.now() } }));

    const sf = window.api?.storageFacade;
    const toggle = sf?.toggleLike?.bind(sf) || window.api?.toggleLike;
    if (typeof toggle !== 'function') {
      showToast('当前平台暂不支持喜欢功能');
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      return;
    }

    // 1. 先切换喜欢状态（轻量 DB 操作，瞬完；Facade 内部已弹 toast）
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
      // 失败 → 回退乐观状态
      setPixivCache(prev => ({ ...prev, [ck]: { ...prev[ck], liked: prevLiked } }));
      showToast('操作失败');
      return;
    }

    // 2. 点♥→后台保存全部页；取消♥→跳过保存
    if (result.liked && typeof onLikeSaveAll === 'function') {
      onLikeSaveAll(cur).catch(() => {});
    }
  }, [cur, pixivCache, setPixivCache, onLikeSaveAll]);

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
      {cfg.like && cur.illustId && (
        <button className="lightbox-dl-btn" onClick={handleLike}>
          <HeartIcon filled={liked} /> 喜欢
        </button>
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

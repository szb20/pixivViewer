import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import { showToast } from '../utils/toast.js';

// 作者资料缓存（userId → { avatar, isFollowed }）：跨页面共享，避免重复请求
const profileCache = new Map();
// 头像持久缓存：userId → avatar URL（成功拉取后写入 localStorage，接口被拦/重启后仍可显示）
const AVATAR_CACHE_KEY = 'pixiv_author_avatars';
function loadAvatarCache() {
  try { return JSON.parse(localStorage.getItem(AVATAR_CACHE_KEY) || '{}') || {}; } catch { return {}; }
}
function saveAvatarCache(id, url) {
  try {
    const map = loadAvatarCache();
    map[id] = url;
    localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify(map));
  } catch { /* 存储不可用时忽略 */ }
}

/**
 * 作者资料 hook — 头像 / 关注状态 / 关注切换。
 * 详情页与作者作品页共用，首次拉一次作者资料，之后命中缓存。
 * @param {string} userId
 * @param {string} [initialAvatar] 列表接口自带的头像，立即展示，不依赖 /ajax/user 请求
 */
export function useAuthorProfile(userId, initialAvatar = '') {
  const id = String(userId || '');
  const [avatar, setAvatar] = useState(initialAvatar || '');
  const [isFollowed, setIsFollowed] = useState(false);
  const [updating, setUpdating] = useState(false);
  // 用户本次会话手动改过关注状态 → 迟到的 profile 响应不得再覆盖它
  // （否则慢网下"点了关注"会在资料返回后自己弹回未关注）
  const followTouchedRef = useRef(false);
  const followedRef = useRef(false);

  useEffect(() => {
    if (!id) return;
    followTouchedRef.current = false;
    // 列表自带头像立即可用；随后若 profile 接口返回更清晰头像则覆盖
    setAvatar(initialAvatar || loadAvatarCache()[id] || '');
    const cached = profileCache.get(id);
    // 空头像不当作有效缓存：避免接口偶发返回空头像时被永久占位
    if (cached?.avatar) {
      setAvatar(cached.avatar);
      setIsFollowed(cached.isFollowed);
      followedRef.current = cached.isFollowed;
      return;
    }
    let cancelled = false;
    const loadProfile = async (attempt = 0) => {
      let profile = null;
      try {
        const r = await pixivApi.fetchUserProfile(id);
        profile = r?.profile;
      } catch { /* 作者资料获取失败不影响页面 */ }
      // 头像为空/获取失败时重试一次，抗接口偶发空响应或被反爬拦截
      if (!profile?.avatar && attempt === 0) {
        setTimeout(() => { if (!cancelled) loadProfile(1); }, 1500);
        return;
      }
      // 缓存里保留用户手动改过的关注状态，别用迟到的响应污染其它页面
      const followed = followTouchedRef.current ? followedRef.current : !!profile?.isFollowed;
      if (profile?.avatar) profileCache.set(id, { avatar: profile.avatar, isFollowed: followed });
      if (!cancelled) {
        // 只有 profile 接口返回了头像才覆盖；为空时保留列表自带头像，避免被反爬空响应顶掉
        if (profile?.avatar) {
          setAvatar(profile.avatar);
          saveAvatarCache(id, profile.avatar);
        }
        if (!followTouchedRef.current) {
          followedRef.current = followed;
          setIsFollowed(followed);
        }
      }
    };
    loadProfile();
    return () => { cancelled = true; };
  }, [id, initialAvatar]);

  const toggleFollow = useCallback(async () => {
    if (!id || updating) return;
    const next = !isFollowed;
    followTouchedRef.current = true; // 用户的意图优先，之后到达的 profile 不再覆盖
    followedRef.current = next;
    setIsFollowed(next); // 乐观更新
    setUpdating(true);
    try {
      const r = next ? await pixivApi.followUser(id) : await pixivApi.unfollowUser(id);
      if (r?.success) {
        if (avatar) profileCache.set(id, { avatar, isFollowed: next });
        showToast(next ? '已关注' : '已取消关注', { type: 'success' });
      } else {
        followedRef.current = !next;
        setIsFollowed(!next);
        showToast(r?.error || '操作失败', { type: 'error' });
      }
    } catch {
      followedRef.current = !next;
      setIsFollowed(!next);
      showToast('操作失败', { type: 'error' });
    } finally {
      setUpdating(false);
    }
  }, [id, isFollowed, updating, avatar]);

  return { avatar, isFollowed, updating, toggleFollow };
}

/**
 * PixivCacheContext — 全量缓存状态拆分为 2 个独立 context + hooks。
 *
 * 让不同消费者只订阅自己关心的子集，避免任何一次 pixivCache 变化都让所有页面重渲染：
 *   - PixivCacheContext    → { pixivCache, setPixivCache }  读写层（详情 / 点赞）
 *   - PixivLikedSetContext → likedSet（红心，只读）           搜索 / 收藏 / 排行 / 发现 网格
 *
 * Provider 见 PixivCacheProvider.jsx。
 */
import { createContext, useContext } from 'react';

export const PixivCacheContext = createContext(null);
export const PixivLikedSetContext = createContext(null);

export function usePixivCache() {
  const ctx = useContext(PixivCacheContext);
  if (!ctx) throw new Error('usePixivCache 必须在 PixivCacheProvider 内使用');
  return ctx;
}

export function useLikedSet() {
  const v = useContext(PixivLikedSetContext);
  if (v == null) throw new Error('useLikedSet 必须在 PixivCacheProvider 内使用');
  return v;
}

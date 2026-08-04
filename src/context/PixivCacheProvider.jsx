/**
 * PixivCacheProvider — 全量缓存状态（喜欢红心）的全局容器。
 *
 * 持有 pixivCache（useState），并派生 likedSet。
 * 通过 3 个独立 context 提供（见 pixivCacheContext.js）。
 *
 * 关键：likedSet 采用"结构相等则复用旧引用"派生——只有喜欢成员真正变化时才更新引用，
 * 避免无关的 pixivCache 变化（如保存动作）触发网格重渲染。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { storageFacade, getCompositeKey } from '../pixiv-assistant/index.js';
import { createLogger } from '../utils/logger.js';
import {
  PixivCacheContext,
  PixivLikedSetContext,
} from './pixivCacheContext.js';

const log = createLogger('PixivCache');

const isLiked = (v) => !!v?.liked;

/** 从 pixivCache 派生过滤后的 Set；成员未真正变化时复用旧引用，避免无关重渲染 */
function useStableFilteredSet(pixivCache, predicate) {
  const ref = useRef(new Set());
  return useMemo(() => {
    const next = new Set();
    for (const [key, val] of Object.entries(pixivCache)) {
      if (predicate(val)) next.add(key);
    }
    const prev = ref.current;
    // 结构相等 → 复用旧引用（无关的 pixivCache 变化不会生成新 Set）
    if (next.size === prev.size && [...prev].every(k => next.has(k))) return prev;
    ref.current = next;
    return next;
  }, [pixivCache, predicate]);
}

export function PixivCacheProvider({ children }) {
  const [pixivCache, setPixivCache] = useState({});

  // 启动时扫描相册/缓存元数据，用于喜欢状态
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await storageFacade.getAll();
        if (cancelled || !Array.isArray(all)) return;
        const patch = {};
        for (const e of all) {
          const ck = getCompositeKey({ illustId: e.illustId, _pageIndex: e.pageIndex ?? 0 });
          patch[ck] = {
            saved: e.isSaved,
            liked: e.isLiked,
            illustId: e.illustId,
          };
        }
        setPixivCache(patch);
      } catch (e) {
        log.warn('启动扫描缓存元数据失败:', e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const likedSet = useStableFilteredSet(pixivCache, isLiked);

  // setPixivCache 引用稳定；cacheValue 只在 pixivCache 变化时更新
  const cacheValue = useMemo(() => ({ pixivCache, setPixivCache }), [pixivCache, setPixivCache]);

  return (
    <PixivCacheContext.Provider value={cacheValue}>
      <PixivLikedSetContext.Provider value={likedSet}>
        {children}
      </PixivLikedSetContext.Provider>
    </PixivCacheContext.Provider>
  );
}

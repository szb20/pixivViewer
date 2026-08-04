import { create } from 'zustand';
import { storageFacade, getCompositeKey } from '../pixiv-assistant/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PixivCacheStore');

const isLiked = (v) => !!v?.liked;

export const usePixivCacheStore = create((set, get) => ({
    pixivCache: {},
    likedSet: new Set(),
    initialized: false,

    initialize: async () => {
        if (get().initialized) return;
        try {
            const all = await storageFacade.getAll();
            if (!Array.isArray(all)) return;
            const patch = {};
            for (const e of all) {
                const ck = getCompositeKey({ illustId: e.illustId, _pageIndex: e.pageIndex ?? 0 });
                patch[ck] = {
                    saved: e.isSaved,
                    liked: e.isLiked,
                    illustId: e.illustId,
                };
            }
            set({ pixivCache: patch, initialized: true });
            get().recalculateLikedSet(patch);
        } catch (e) {
            log.warn('启动扫描缓存元数据失败:', e?.message || e);
            set({ initialized: true });
        }
    },

    recalculateLikedSet: (cache) => {
        const next = new Set();
        for (const [key, val] of Object.entries(cache || get().pixivCache)) {
            if (isLiked(val)) next.add(key);
        }
        const prev = get().likedSet;
        if (next.size === prev.size && [...prev].every(k => next.has(k))) {
            return;
        }
        set({ likedSet: next });
    },

    setPixivCache: (updater) => {
        const current = get().pixivCache;
        const next = typeof updater === 'function' ? updater(current) : updater;
        set({ pixivCache: next });
        get().recalculateLikedSet(next);
    },

    updateEntry: (key, value) => {
        const { pixivCache } = get();
        const next = { ...pixivCache, [key]: value };
        set({ pixivCache: next });
        get().recalculateLikedSet(next);
    },

    deleteEntry: (key) => {
        const { pixivCache } = get();
        const next = { ...pixivCache };
        delete next[key];
        set({ pixivCache: next });
        get().recalculateLikedSet(next);
    },

    isLiked: (key) => {
        return get().likedSet.has(key);
    },
}));
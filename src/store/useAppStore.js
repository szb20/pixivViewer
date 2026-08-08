import { create } from 'zustand';
import { getMainScrollEl, restoreMainScroll } from '../utils/scroll.js';

const TABS = [
    { key: 'discover', label: '推荐' },
    { key: 'ranking', label: '排行' },
    { key: 'search', label: '搜索' },
    { key: 'me', label: '我' },
];

const detailKeyOf = (item) => (
    item?.illustId ? `${item.illustId}:${item._pageIndex ?? item.pageIndex ?? 0}` : ''
);

const normalizeDetailContext = (img, context) => {
    const items = Array.isArray(context?.items) ? context.items.filter(Boolean) : [];
    if (!items.length) return null;
    const currentKey = detailKeyOf(img);
    let index = Number.isInteger(context?.index) ? context.index : -1;
    if (index < 0 || index >= items.length || detailKeyOf(items[index]) !== currentKey) {
        index = items.findIndex(item => detailKeyOf(item) === currentKey);
    }
    return index >= 0 ? { items, index } : null;
};

const authorItemToDetail = (item, fallback = {}) => ({
    illustId: item.illustId,
    title: item.title || '',
    author: item.authorName || fallback.authorName || '',
    authorName: item.authorName || fallback.authorName || '',
    authorId: item.authorId || fallback.authorId || '',
    authorAvatar: item.authorAvatar || fallback.authorAvatar || '',
    thumbnailUrl: item.thumbnailUrl,
    mediumUrl: item.mediumUrl,
    originalUrl: item.originalUrl || item.mediumUrl,
    type: item.type || 'image',
    illustType: item.illustType ?? 0,
    _totalPages: item.pageCount || 1,
    _openTransition: item._openTransition,
});

export const useAppStore = create((set, get) => ({
    // ========== Tab 相关 ==========
    tabs: TABS,
    activeTab: 'discover',
    visitedTabs: new Set(['discover']),
    scrollPositions: {},
    tabTokens: {},
    refreshFns: {},

    setActiveTab: (key) => {
        const { activeTab, scrollPositions, tabTokens, visitedTabs } = get();
        const el = getMainScrollEl();
        const nextScrollPositions = el
            ? { ...scrollPositions, [activeTab]: el.scrollTop }
            : scrollPositions;
        if (key === activeTab) {
            set({
                scrollPositions: nextScrollPositions,
                tabTokens: { ...tabTokens, [key]: (tabTokens[key] || 0) + 1 },
            });
            return;
        }
        const newVisited = new Set(visitedTabs);
        newVisited.add(key);
        set({ activeTab: key, visitedTabs: newVisited, scrollPositions: nextScrollPositions });
        restoreMainScroll(nextScrollPositions[key] || 0);
    },

    saveScrollPosition: (tab, scrollTop) => {
        const { scrollPositions } = get();
        set({ scrollPositions: { ...scrollPositions, [tab]: scrollTop } });
    },

    registerRefresh: (key, fn) => {
        const { refreshFns } = get();
        set({ refreshFns: { ...refreshFns, [key]: fn } });
        return () => {
            const { refreshFns: current } = get();
            if (current[key] === fn) {
                const next = { ...current };
                delete next[key];
                set({ refreshFns: next });
            }
        };
    },

    triggerPullRefresh: async () => {
        const { activeTab, refreshFns } = get();
        const fn = refreshFns[activeTab];
        if (fn) await fn();
    },

    // ========== 详情页相关 ==========
    detailImage: null,
    detailContext: null,
    authorWorks: null,
    // 从作者页打开详情时记录返回目标（关闭详情时回到作者页，而非直接回首页）
    returnToAuthor: null,
    searchSeed: null,
    settingsOpen: false,
    showProxyError: false,
    proxyCheckUrl: '',

    openDetail: (img, context = null) => {
        const { activeTab, scrollPositions } = get();
        const el = getMainScrollEl();
        if (el) {
            set({ scrollPositions: { ...scrollPositions, [activeTab]: el.scrollTop } });
        }
        // 普通路径打开详情（列表/推荐/相关）→ 清除"从作者页返回"标记
        set({ detailImage: img, detailContext: normalizeDetailContext(img, context), returnToAuthor: null });
    },

    closeDetail: () => {
        const { activeTab, scrollPositions, returnToAuthor } = get();
        set({ detailImage: null, detailContext: null, returnToAuthor: null });
        if (returnToAuthor) {
            // 从作者页打开的详情 → 关闭时回到作者页
            set({ authorWorks: returnToAuthor });
            return;
        }
        restoreMainScroll(scrollPositions[activeTab] || 0);
    },

    // 直接退出到主页（详情页左上角"‹"按钮）：清空详情/作者页，不返回作者页
    exitToHome: () => {
        const { activeTab, scrollPositions } = get();
        set({ detailImage: null, detailContext: null, authorWorks: null, returnToAuthor: null });
        // 恢复进入详情前的滚动位置，避免退出后网格停在顶部
        restoreMainScroll(scrollPositions[activeTab] || 0);
    },

    openAuthorWorks: (authorId, authorName, authorAvatar) => {
        if (!authorId) return;
        set({ authorWorks: { authorId: String(authorId), authorName: authorName || '', authorAvatar: authorAvatar || '' } });
    },

    closeAuthorWorks: () => {
        set({ authorWorks: null });
    },

    openAuthorImage: (item, context = null) => {
        const { authorWorks } = get();
        const returnTarget = authorWorks;
        set({ authorWorks: null });
        const fallback = {
            authorName: authorWorks?.authorName || '',
            authorId: authorWorks?.authorId || '',
            authorAvatar: authorWorks?.authorAvatar || '',
        };
        const detailItem = authorItemToDetail(item, fallback);
        const detailContext = Array.isArray(context?.items)
            ? { ...context, items: context.items.map(it => authorItemToDetail(it, fallback)) }
            : context;
        get().openDetail(detailItem, detailContext);
        // openDetail 会清 returnToAuthor，这里再补回"从作者页打开"的返回目标
        set({ returnToAuthor: returnTarget });
    },

    searchByTag: (tag) => {
        if (!tag) return;
        set({ detailImage: null, detailContext: null, returnToAuthor: null });
        const { visitedTabs } = get();
        const newVisited = new Set(visitedTabs);
        newVisited.add('search');
        set({ activeTab: 'search', visitedTabs: newVisited, searchSeed: { tag, seq: Date.now() } });
    },

    openSettings: () => set({ settingsOpen: true }),
    closeSettings: () => set({ settingsOpen: false }),

    setShowProxyError: (v, url = '') => set({ showProxyError: v, proxyCheckUrl: url }),
}));

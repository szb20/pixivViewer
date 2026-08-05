import { create } from 'zustand';

const TABS = [
    { key: 'discover', label: '推荐' },
    { key: 'ranking', label: '排行' },
    { key: 'bookmarks', label: '收藏' },
    { key: 'search', label: '搜索' },
    { key: 'gallery', label: '喜欢' },
];

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
        const el = document.querySelector('.app-content');
        if (el) {
            scrollPositions[activeTab] = el.scrollTop;
        }
        if (key === activeTab) {
            set({ tabTokens: { ...tabTokens, [key]: (tabTokens[key] || 0) + 1 } });
            return;
        }
        const newVisited = new Set(visitedTabs);
        newVisited.add(key);
        set({ activeTab: key, visitedTabs: newVisited });
        requestAnimationFrame(() => {
            const el2 = document.querySelector('.app-content');
            if (el2) el2.scrollTop = scrollPositions[key] || 0;
        });
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
    authorWorks: null,
    searchSeed: null,
    settingsOpen: false,
    showProxyError: false,
    proxyCheckUrl: '',

    openDetail: (img) => {
        const { activeTab, scrollPositions } = get();
        const el = document.querySelector('.app-content');
        if (el) {
            set({ scrollPositions: { ...scrollPositions, [activeTab]: el.scrollTop } });
        }
        set({ detailImage: img });
    },

    closeDetail: () => {
        const { activeTab, scrollPositions } = get();
        set({ detailImage: null });
        requestAnimationFrame(() => {
            const el = document.querySelector('.app-content');
            if (el) el.scrollTop = scrollPositions[activeTab] || 0;
        });
    },

    openAuthorWorks: (authorId, authorName) => {
        if (!authorId) return;
        set({ authorWorks: { authorId: String(authorId), authorName: authorName || '' } });
    },

    closeAuthorWorks: () => {
        set({ authorWorks: null });
    },

    openAuthorImage: (item) => {
        const { authorWorks } = get();
        set({ authorWorks: null });
        get().openDetail({
            illustId: item.illustId,
            title: item.title || '',
            author: item.authorName || authorWorks?.authorName || '',
            authorName: item.authorName || authorWorks?.authorName || '',
            authorId: item.authorId || authorWorks?.authorId || '',
            thumbnailUrl: item.thumbnailUrl,
            mediumUrl: item.mediumUrl,
            originalUrl: item.originalUrl || item.mediumUrl,
            type: item.type || 'image',
            illustType: item.illustType ?? 0,
            _totalPages: item.pageCount || 1,
        });
    },

    searchByTag: (tag) => {
        if (!tag) return;
        set({ detailImage: null });
        const { visitedTabs } = get();
        const newVisited = new Set(visitedTabs);
        newVisited.add('search');
        set({ activeTab: 'search', visitedTabs: newVisited, searchSeed: { tag, seq: Date.now() } });
    },

    openSettings: () => set({ settingsOpen: true }),
    closeSettings: () => set({ settingsOpen: false }),

    setShowProxyError: (v, url = '') => set({ showProxyError: v, proxyCheckUrl: url }),
}));
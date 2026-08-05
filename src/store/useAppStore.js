import { create } from 'zustand';

const TABS = [
    { key: 'discover', label: '推荐' },
    { key: 'ranking', label: '排行' },
    { key: 'search', label: '搜索' },
    { key: 'me', label: '我' },
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
    // 从作者页打开详情时记录返回目标（关闭详情时回到作者页，而非直接回首页）
    returnToAuthor: null,
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
        // 普通路径打开详情（列表/推荐/相关）→ 清除"从作者页返回"标记
        set({ detailImage: img, returnToAuthor: null });
    },

    closeDetail: () => {
        const { activeTab, scrollPositions, returnToAuthor } = get();
        set({ detailImage: null, returnToAuthor: null });
        if (returnToAuthor) {
            // 从作者页打开的详情 → 关闭时回到作者页
            set({ authorWorks: returnToAuthor });
            return;
        }
        requestAnimationFrame(() => {
            const el = document.querySelector('.app-content');
            if (el) el.scrollTop = scrollPositions[activeTab] || 0;
        });
    },

    // 直接退出到主页（详情页左上角"‹"按钮）：清空详情/作者页，不返回作者页
    exitToHome: () => {
        const { activeTab, scrollPositions } = get();
        set({ detailImage: null, authorWorks: null, returnToAuthor: null });
        // 恢复进入详情前的滚动位置，避免退出后网格停在顶部
        requestAnimationFrame(() => {
            const el = document.querySelector('.app-content');
            if (el) el.scrollTop = scrollPositions[activeTab] || 0;
        });
    },

    openAuthorWorks: (authorId, authorName, authorAvatar) => {
        if (!authorId) return;
        set({ authorWorks: { authorId: String(authorId), authorName: authorName || '', authorAvatar: authorAvatar || '' } });
    },

    closeAuthorWorks: () => {
        set({ authorWorks: null });
    },

    openAuthorImage: (item) => {
        const { authorWorks } = get();
        const returnTarget = authorWorks;
        set({ authorWorks: null });
        get().openDetail({
            illustId: item.illustId,
            title: item.title || '',
            author: item.authorName || authorWorks?.authorName || '',
            authorName: item.authorName || authorWorks?.authorName || '',
            authorId: item.authorId || authorWorks?.authorId || '',
            authorAvatar: item.authorAvatar || authorWorks?.authorAvatar || '',
            thumbnailUrl: item.thumbnailUrl,
            mediumUrl: item.mediumUrl,
            originalUrl: item.originalUrl || item.mediumUrl,
            type: item.type || 'image',
            illustType: item.illustType ?? 0,
            _totalPages: item.pageCount || 1,
        });
        // openDetail 会清 returnToAuthor，这里再补回"从作者页打开"的返回目标
        set({ returnToAuthor: returnTarget });
    },

    searchByTag: (tag) => {
        if (!tag) return;
        set({ detailImage: null, returnToAuthor: null });
        const { visitedTabs } = get();
        const newVisited = new Set(visitedTabs);
        newVisited.add('search');
        set({ activeTab: 'search', visitedTabs: newVisited, searchSeed: { tag, seq: Date.now() } });
    },

    openSettings: () => set({ settingsOpen: true }),
    closeSettings: () => set({ settingsOpen: false }),

    setShowProxyError: (v, url = '') => set({ showProxyError: v, proxyCheckUrl: url }),
}));

import { create } from 'zustand';
import { getMainScrollEl, restoreMainScroll } from '../utils/scroll.js';
import { nextRankingSelection, canToggleR18 } from '../utils/rankingModes.js';

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

// ===== 滚动位置持久化（页面快照）=====
// 会话内靠页面保活（display:none）+ 内存 scrollPositions 恢复；
// App 重启后内存丢失，这里把各 tab 的 scrollTop 存进 localStorage，
// 冷启动后 setActiveTab / 挂载恢复逻辑直接从持久化值取。
const SCROLL_STORE_KEY = 'pv:scrollPositions';

function loadScrollPositions() {
    try {
        return JSON.parse(localStorage.getItem(SCROLL_STORE_KEY) || '{}') || {};
    } catch {
        return {};
    }
}

function persistScrollPositions(sp) {
    try {
        localStorage.setItem(SCROLL_STORE_KEY, JSON.stringify(sp || {}));
    } catch { /* 存储不可用时静默跳过 */ }
}

export const useAppStore = create((set, get) => ({
    // ========== Tab 相关 ==========
    activeTab: 'discover',
    visitedTabs: new Set(['discover']),
    scrollPositions: loadScrollPositions(),
    tabTokens: {},
    refreshFns: {},
    // 「我」页当前子页签。桌面侧边栏要驱动它，所以放在 store 而非 MePage 局部状态
    meSubTab: 'liked',

    setMeSubTab: (key) => set({ meSubTab: key }),

    // 排行榜当前档位与 R18 开关。同样是为了让桌面侧边栏能驱动（手机端是底部的筛选条）
    rankingCategory: 'daily',
    rankingR18: false, // 默认只看公开档，R18 需手动开启

    // 选档位时按耦合规则同步 R18（选 R18G 自动开、选无 R18 变体的档自动关）
    selectRankingCategory: (key) => set((s) => {
        const next = nextRankingSelection(key, s.rankingR18);
        return { rankingCategory: next.category, rankingR18: next.r18 };
    }),

    toggleRankingR18: () => set((s) => (
        // 档位不支持 R18 变体时按了没反应（R18G 固定 R18、月/新人/原创 无 R18 档）
        canToggleR18(s.rankingCategory) ? { rankingR18: !s.rankingR18 } : {}
    )),

    // 缓存恢复用：档位与 R18 来自同一条缓存记录，必须一次写入，避免被耦合规则改写
    setRankingSelection: ({ category, r18 }) => set((s) => ({
        rankingCategory: category ?? s.rankingCategory,
        rankingR18: typeof r18 === 'boolean' ? r18 : s.rankingR18,
    })),

    setActiveTab: (key) => {
        const {
            activeTab, scrollPositions, tabTokens, visitedTabs,
            detailImage, authorWorks, settingsOpen, searchComposerOpen,
        } = get();
        const el = getMainScrollEl();
        const nextScrollPositions = el
            ? { ...scrollPositions, [activeTab]: el.scrollTop }
            : scrollPositions;
        persistScrollPositions(nextScrollPositions);

        // 桌面端侧边栏常驻在详情/作者页/设置之上，点导航即关闭覆盖层回到列表。
        // 覆盖层开着时点当前 tab 只负责关闭，不再顺带触发刷新 ——
        // 列表根本没换，刷新只会白白丢掉滚动位置。
        const hadOverlay = !!(detailImage || authorWorks || settingsOpen || searchComposerOpen);
        const closed = {
            detailImage: null, detailContext: null, returnToAuthor: null,
            authorWorks: null, settingsOpen: false, searchComposerOpen: false,
        };

        if (key === activeTab) {
            set({
                scrollPositions: nextScrollPositions,
                ...(hadOverlay
                    ? {}
                    : { tabTokens: { ...tabTokens, [key]: (tabTokens[key] || 0) + 1 } }),
                ...closed,
            });
            if (hadOverlay) restoreMainScroll(nextScrollPositions[key] || 0);
            return;
        }
        const newVisited = new Set(visitedTabs);
        newVisited.add(key);
        set({ activeTab: key, visitedTabs: newVisited, scrollPositions: nextScrollPositions, ...closed });
        restoreMainScroll(nextScrollPositions[key] || 0);
    },

    saveScrollPosition: (tab, scrollTop) => {
        const { scrollPositions } = get();
        const next = { ...scrollPositions, [tab]: scrollTop };
        persistScrollPositions(next);
        set({ scrollPositions: next });
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

    // ========== 桌面端搜索悬浮框 ==========
    // 侧边栏点「搜索」不再跳页，而是在当前页面上浮出搜索框；提交后才切到搜索页。
    // 写它的（侧边栏）和读它的（SearchPage 的 portal 搜索栏）是两棵渲染树，所以放 store。
    // seq 给「已经开着再点一次」用：状态没变不会触发重渲染，靠它重新聚焦输入框。
    searchComposerOpen: false,
    searchComposerSeq: 0,
    // 唤起搜索前所在的 tab，供结果页「‹」返回
    searchReturnTab: null,

    openSearchComposer: () => set((s) => ({
        searchComposerOpen: true,
        searchComposerSeq: s.searchComposerSeq + 1,
        searchReturnTab: s.activeTab === 'search' ? s.searchReturnTab : s.activeTab,
        // 详情 / 作者页 / 设置都盖在搜索框上方（z-index 更高），不关掉的话点了像没反应
        detailImage: null,
        detailContext: null,
        returnToAuthor: null,
        authorWorks: null,
        settingsOpen: false,
    })),

    closeSearchComposer: () => set((s) => (s.searchComposerOpen ? { searchComposerOpen: false } : {})),

    // 收起全部覆盖层。切来源（换的是整份列表）必须调用：
    // 详情/设置盖在上面时只换底下的列表，用户看到的画面纹丝不动，像是点了没反应。
    closeOverlays: () => set({
        detailImage: null,
        detailContext: null,
        returnToAuthor: null,
        authorWorks: null,
        settingsOpen: false,
        searchComposerOpen: false,
    }),

    // ========== 详情页相关 ==========
    detailImage: null,
    detailContext: null,
    authorWorks: null,
    // 从作者页打开详情时记录返回目标（关闭详情时回到作者页，而非直接回首页）
    returnToAuthor: null,
    searchSeed: null,
    settingsOpen: false,

    openDetail: (img, context = null) => {
        const { activeTab, scrollPositions } = get();
        const el = getMainScrollEl();
        if (el) {
            const next = { ...scrollPositions, [activeTab]: el.scrollTop };
            persistScrollPositions(next);
            set({ scrollPositions: next });
        }
        // 普通路径打开详情（列表/推荐/相关）→ 清除"从作者页返回"标记；
        // 搜索悬浮框被详情盖住（z-index 更低），顺手收起
        set({
            detailImage: img,
            detailContext: normalizeDetailContext(img, context),
            returnToAuthor: null,
            searchComposerOpen: false,
        });
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
        // 不卸载作者页（保持 <img> 存活），由 App 层在详情打开时用 display:none 隐藏，
        // 避免退出详情时作者页重挂载导致全部图片重新加载
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
        // 同时关掉作者页（若从作者页详情跳转），否则作者页会残留在搜索页上层
        set({ detailImage: null, detailContext: null, returnToAuthor: null, authorWorks: null, searchComposerOpen: false });
        const { visitedTabs, activeTab, searchReturnTab } = get();
        const newVisited = new Set(visitedTabs);
        newVisited.add('search');
        set({
            activeTab: 'search',
            visitedTabs: newVisited,
            searchSeed: { tag, seq: Date.now() },
            // 供结果页「‹」返回：留在原 tab，别被自己覆盖成 'search'
            searchReturnTab: activeTab === 'search' ? searchReturnTab : activeTab,
        });
    },

    openSettings: () => set({ settingsOpen: true, searchComposerOpen: false }),
    closeSettings: () => set({ settingsOpen: false }),

    // 下载管理弹窗。放 store 是因为侧边栏也有一个常驻入口要能打开它
    downloadOpen: false,
    setDownloadOpen: (v) => set({ downloadOpen: v }),
}));
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pixivApi } from '../api/pixiv.js';
import { useTabFeed } from '../hooks/useTabFeed.js';
import { useLikedSet } from '../context/pixivCacheContext.js';
import ImageGrid from '../components/ImageGrid.jsx';
import SearchIcon from '../components/icons/SearchIcon.jsx';
import BackIcon from '../components/icons/BackIcon.jsx';
import { appStorage, migrateFromLegacyKey } from '../utils/appStorage.js';
import { getMainScrollEl } from '../utils/scroll.js';
import { useImageSourceId, useBooruSafeOnly } from '../hooks/useImageSource.js';
import { useIsDesktop } from '../hooks/useIsDesktop.js';
import { useOverlayFocus } from '../hooks/useOverlayFocus.js';
import { useAppStore } from '../store/useAppStore.js';
import { booruApiFor } from '../sources/api.js';
import { scopedTabKey } from '../pixiv-assistant/index.js';
import '../styles/search.css';

const PAGE_SIZE = 20;
const CACHE_KEY = 'search:last';
const HISTORY_KEY = 'searchHistory';
const HISTORY_LIMIT = 12;

function normalizeHistory(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const next = [];
  for (const raw of list) {
    const item = String(raw || '').trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
    if (next.length >= HISTORY_LIMIT) break;
  }
  return next;
}

// 迁移旧版独立历史 key → 统一 key
migrateFromLegacyKey('pixiv_search_history', HISTORY_KEY);

/**
 * 最近搜索面板 —— 手机渲染在页内 .search-head，桌面渲染成悬浮搜索框下方的下拉。
 * variant='dropdown' 时多一个定位 / 面板样式类。
 */
function HistoryPanel({ history, onPick, onRemove, onClear, variant = '', ...rest }) {
  return (
    <div className={`search-history${variant ? ` search-history--${variant}` : ''}`} {...rest}>
      <div className="search-history-head">
        <span className="search-history-label">最近搜索</span>
        <button type="button" className="search-history-clear" onClick={onClear}>清空</button>
      </div>
      <div className="search-history-tags">
        {history.map(h => (
          <span className="search-history-chip" key={h}>
            <button
              type="button"
              className="search-history-tag"
              onClick={() => onPick(h)}
            >{h}</button>
            <button
              type="button"
              className="search-history-delete"
              aria-label={`删除 ${h}`}
              onClick={(e) => { e.stopPropagation(); onRemove(h); }}
            >×</button>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function SearchPage({ active = true, onOpen, registerRefresh, refreshToken = 0, searchSeed = null }) {
  const likedSet = useLikedSet();
  const sourceId = useImageSourceId();
  const safeOnly = useBooruSafeOnly();
  const booruApi = booruApiFor(sourceId);
  const isBooru = !!booruApi;
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState(false);
  const [history, setHistory] = useState(() => {
    const normalized = normalizeHistory(appStorage.get(HISTORY_KEY, []));
    appStorage.set(HISTORY_KEY, normalized);
    return normalized;
  });
  const [searchFocused, setSearchFocused] = useState(false);
  const [hideBar, setHideBar] = useState(false); // 滚动时弹入/弹出搜索栏（同筛选栏）
  const queryRef = useRef('');
  const pageRef = useRef(1);

  const isDesktop = useIsDesktop();
  const composerOpen = useAppStore(s => s.searchComposerOpen);
  const composerSeq = useAppStore(s => s.searchComposerSeq);
  const searchReturnTab = useAppStore(s => s.searchReturnTab);
  const setActiveTab = useAppStore(s => s.setActiveTab);
  const closeSearchComposer = useAppStore(s => s.closeSearchComposer);
  const inputRef = useRef(null);
  // Esc（只作用最上层覆盖层）与关闭后的焦点归还由它负责；
  // 同一个 ref 顺带给「点空白处关闭」做包含判定
  const barRef = useOverlayFocus(isDesktop && composerOpen, closeSearchComposer);
  // 桌面端搜索面板启动即挂载（保持隐藏），首帧 .app 还没进 DOM——
  // portal 目标必须等挂载后再解析，否则 createPortal(node, null) 直接抛错
  const [portalTarget, setPortalTarget] = useState(null);
  useLayoutEffect(() => {
    setPortalTarget(document.querySelector('.app'));
  }, []);

  const feed = useTabFeed({
    cacheKey: scopedTabKey(sourceId, CACHE_KEY),
    registerRefresh,
    refreshKey: 'search',
    refreshToken,
    // 搜索不自动首拉，只有用户提交 / 点历史 / 详情页点 Tag 时才发起
    autoLoad: false,
    hydrate: (cache) => {
      const items = cache?.items || cache?.results || [];
      if (!items.length) return null;
      // 用户已在本会话发起过搜索（例如从详情页点 Tag 进来）→ 不让迟到的缓存水合
      // 覆盖当前查询词，否则输入框会跳回上一次的词，而列表是新词的结果
      if (queryRef.current) return null;
      queryRef.current = cache.query || '';
      setQuery(cache.query || '');
      if (cache.page > 0) pageRef.current = cache.page;
      if (cache.searched) setSearched(true);
      return { items, hasMore: !!cache.hasMore };
    },
    fetchPage: async (append, currentItems, isStale) => {
      const q = queryRef.current.trim();
      if (!q) return null;
      const page = append ? pageRef.current + 1 : 1;

      // ── 非 Pixiv 来源：Moebooru 用 page 翻页，最后一页不满即到底 ──
      if (isBooru) {
        const r = await booruApi.search(q, { page, limit: PAGE_SIZE, safeOnly });
        if (isStale?.()) return null;
        const list = r?.images || [];
        const failed = !list.length && !!r?.error;
        if (!failed) pageRef.current = page;
        return {
          list,
          hasMore: list.length >= PAGE_SIZE,
          error: r?.error || '',
          emptyMessage: r?.error || '没有找到结果',
          cacheExtra: { query: q, page: pageRef.current, searched: true },
        };
      }

      const r = await pixivApi.searchPixiv(q, { page, count: PAGE_SIZE });
      // 已被新搜索取代 → 不占用游标、不返回数据（否则换词后旧响应会把 pageRef 推走）
      if (isStale?.()) return null;
      const list = r?.images || [];
      // 失败（有 error 且无数据）不推进游标，重试才会重拉同一页
      const failed = !list.length && !!r?.error;
      if (!failed) pageRef.current = page;
      // 有服务端 total 时用它收敛边界，避免最后一页恰好满页时多请求一次空数据
      const serverTotal = r?.total;
      const hasServerTotal = Number.isFinite(serverTotal) && serverTotal > list.length;
      const hasMore = list.length >= PAGE_SIZE
        && (!hasServerTotal || page * PAGE_SIZE < serverTotal);
      return {
        list,
        hasMore,
        error: r?.error || '',
        emptyMessage: r?.error || '没有找到结果',
        cacheExtra: { query: q, page: pageRef.current, searched: true },
      };
    },
  });
  const { load: reload } = feed;

  const runSearch = useCallback((q) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    queryRef.current = trimmed;
    setQuery(trimmed);
    setHistory(prev => {
      const next = normalizeHistory([trimmed, ...prev]);
      appStorage.set(HISTORY_KEY, next);
      return next;
    });
    setSearched(true);
    reload(false);
  }, [reload]);

  const clearHistory = useCallback(() => {
    appStorage.remove(HISTORY_KEY);
    setHistory([]);
  }, []);

  // 下拉刷新按 tab key（'search'）注册由 useTabFeed 的 refreshKey 负责：
  // store 的 triggerPullRefresh 取 refreshFns[activeTab]，而持久化 cacheKey 带来源前缀。

  const removeHistory = useCallback((item) => {
    setHistory(prev => {
      const key = String(item || '').trim().toLowerCase();
      const next = prev.filter(h => h.toLowerCase() !== key);
      if (next.length) appStorage.set(HISTORY_KEY, next);
      else appStorage.remove(HISTORY_KEY);
      return next;
    });
  }, []);

  // 回车 / 点历史词：手机只重跑搜索（与今天一致）；
  // 桌面端若还停在别的页面，搜完顺手切到结果页（setActiveTab 会顺带收起唤起态）
  const performSearch = useCallback((raw) => {
    const q = String(raw || '').trim();
    if (!q) return;
    runSearch(q);
    if (!isDesktop) return;
    inputRef.current?.blur();
    if (!active) setActiveTab('search');
  }, [runSearch, isDesktop, active, setActiveTab]);

  const submit = (e) => { e.preventDefault(); performSearch(query); };

  const barVisible = isDesktop ? (active || composerOpen) : active;
  const showHistory = history.length > 0 && (!searched || searchFocused);
  // 桌面端历史只出现在悬浮框下方的下拉里，避免和结果页页内的那组重复
  const showHistoryDropdown = isDesktop && barVisible && history.length > 0
    && (composerOpen || searchFocused);
  // 结果页「‹」返回：只在有明确来路（唤起搜索前所在的 tab）时出现
  const showBack = isDesktop && active && !!searchReturnTab && searchReturnTab !== 'search';

  // 详情页点 Tag → 关闭详情并切到搜索 tab 后直接搜索该 tag
  useEffect(() => {
    if (!searchSeed?.tag) return;
    runSearch(searchSeed.tag);
  }, [searchSeed, runSearch]);

  // 滚动收起：上下滑动都隐藏搜索栏（弹出靠双击当前 Tab）
  // active 守卫：四个 tab 共用一个滚动容器，隐藏页若继续监听，
  // 在推荐页滚动会把搜索栏收起，切回来时输入框看不见也点不到
  useEffect(() => {
    if (!active) return;
    const el = getMainScrollEl();
    if (!el) return;
    let last = el.scrollTop;
    const onScroll = () => {
      const t = el.scrollTop;
      if (Math.abs(t - last) > 20) setHideBar(true);
      last = t;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [active]);

  // 点击弹出：双击当前 Tab（refreshToken 触发）→ 弹出搜索栏。
  // 跳过挂载那一次（切来源会整块重挂载，沿用旧 token 不该当作一次"双击"）。
  const lastTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken > 0 && refreshToken !== lastTokenRef.current) setHideBar(false);
    lastTokenRef.current = refreshToken;
  }, [refreshToken]);

  // 回到本 tab 时恢复搜索栏（隐藏期间可能被其他 tab 的滚动收起）
  useEffect(() => {
    if (active) setHideBar(false);
  }, [active]);

  // ── 桌面端悬浮搜索框（唤起态）──
  // 唤起 → 聚焦输入框；已开着再点一次侧边栏时 seq 会 +1，同样重新聚焦
  const lastComposerSeqRef = useRef(composerSeq);
  useEffect(() => {
    if (composerSeq === lastComposerSeqRef.current) return;
    lastComposerSeqRef.current = composerSeq;
    if (!isDesktop || !composerOpen) return;
    setHideBar(false);
    const el = inputRef.current;
    el?.focus({ preventScroll: true });
    el?.select(); // 上次的词成选中态，直接打字即覆盖
  }, [composerSeq, isDesktop, composerOpen]);

  // 收起唤起态时主动失焦，免得 searchFocused 残留到下一次打开
  useEffect(() => {
    if (!composerOpen && isDesktop) inputRef.current?.blur();
  }, [composerOpen, isDesktop]);

  // 点空白处关闭唤起态。非模态：这次点击照常落到页面上（可能顺势打开作品）
  useEffect(() => {
    if (!isDesktop || !composerOpen) return undefined;
    const onPointerDown = (e) => {
      if (barRef.current?.contains(e.target)) return;
      // 侧边栏「搜索」项自己负责开/关，跳过，免得太快「先关再开」闪一下
      if (e.target?.closest?.('[data-search-toggle]')) return;
      closeSearchComposer();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [isDesktop, composerOpen, closeSearchComposer, barRef]);

  return (
    <div className="page search-page">
      <div className="search-head">
        {/* 桌面端这组历史移进了悬浮框下方的下拉（见 portal 里的 HistoryPanel） */}
        {!isDesktop && showHistory && (
          <HistoryPanel
            history={history}
            onPick={performSearch}
            onRemove={removeHistory}
            onClear={clearHistory}
          />
        )}

        {feed.error && (
          <div className="error-box">
            {feed.error}
            <button type="button" className="error-retry" onClick={() => runSearch(queryRef.current || query)}>重试</button>
          </div>
        )}
      </div>

      <ImageGrid items={feed.items} likedSet={likedSet} onOpen={onOpen} />
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
      {feed.loadingMore && <div className="hint">加载中...</div>}
      {!feed.loading && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}

      {portalTarget && createPortal(
        <form
          ref={barRef}
          className={`search-bar search-bar--top${hideBar ? ' search-bar--hidden' : ''}`}
          style={{ display: barVisible ? 'flex' : 'none' }}
          onSubmit={submit}
        >
          {showBack && (
            <button
              type="button"
              className="search-back"
              aria-label="返回"
              onClick={() => setActiveTab(searchReturnTab)}
            >
              <BackIcon className="search-back-icon" size={18} />
            </button>
          )}
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            value={query}
            placeholder="标签 / 作品ID"
            enterKeyHint="search"
            onFocus={() => { setSearchFocused(true); setHideBar(false); }}
            onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
            onChange={e => setQuery(e.target.value)}
          />
          <button className="search-submit" type="submit" disabled={feed.loading} aria-label="搜索">
            {feed.loading ? <span className="search-submit-spinner" /> : <SearchIcon className="search-submit-icon" />}
          </button>
          {/* 最近搜索下拉：按下时不夺焦点，否则 120ms 的失焦延迟会先把面板收掉，慢点击点不中 */}
          {showHistoryDropdown && (
            <HistoryPanel
              variant="dropdown"
              onMouseDown={e => e.preventDefault()}
              history={history}
              onPick={performSearch}
              onRemove={removeHistory}
              onClear={clearHistory}
            />
          )}
        </form>,
        portalTarget
      )}
    </div>
  );
}

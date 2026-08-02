import { useEffect, useMemo, useRef, useState } from 'react';
import TabBar from './components/TabBar.jsx';
import ToastHost from './components/ToastHost.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import DetailView from './components/detail/DetailView.jsx';
import DiscoverPage from './pages/DiscoverPage.jsx';
import RankingPage from './pages/RankingPage.jsx';
import BookmarksPage from './pages/BookmarksPage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import GalleryPage from './pages/GalleryPage.jsx';
import { storageFacade, getCompositeKey } from './pixiv-assistant/index.js';
import { runBackHandlers } from './utils/backHandler.js';
import './index.css';
import './styles/detail.css';

// 开发期调试入口
window.__pixivViewer = window.__pixivViewer || { storageFacade };

const TABS = [
  { key: 'discover', label: '推荐' },
  { key: 'ranking', label: '排行' },
  { key: 'bookmarks', label: '收藏' },
  { key: 'search', label: '搜索' },
  { key: 'gallery', label: '喜欢' },
];

export default function App() {
  const [tab, setTab] = useState('ranking');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailImage, setDetailImage] = useState(null);
  const [searchSeed, setSearchSeed] = useState(null);
  // 各 tab 的滚动位置 / 已访问记录 / 刷新令牌（重点当前 tab 时 +1 触发强制刷新）
  const scrollPositions = useRef({});
  const visitedTabs = useRef(new Set(['ranking']));
  const [tabTokens, setTabTokens] = useState({});

  const openDetail = (img) => {
    const el = document.querySelector('.app-content');
    if (el) scrollPositions.current[tab] = el.scrollTop;
    setDetailImage(img);
  };
  const closeDetail = () => {
    setDetailImage(null);
    requestAnimationFrame(() => {
      const el = document.querySelector('.app-content');
      if (el) el.scrollTop = scrollPositions.current[tab] || 0;
    });
  };
  const handleTabChange = (key) => {
    const el = document.querySelector('.app-content');
    if (el) scrollPositions.current[tab] = el.scrollTop;
    if (key === tab) {
      // 重点当前 tab → 强制重新加载
      setTabTokens(t => ({ ...t, [key]: (t[key] || 0) + 1 }));
      return;
    }
    visitedTabs.current.add(key);
    setTab(key);
    requestAnimationFrame(() => {
      const el2 = document.querySelector('.app-content');
      if (el2) el2.scrollTop = scrollPositions.current[key] || 0;
    });
  };
  // 详情页点 Tag → 关闭详情、切到搜索 tab 并搜该 tag
  const handleSearchTag = (tag) => {
    if (!tag) return;
    setDetailImage(null);
    visitedTabs.current.add('search');
    setTab('search');
    setSearchSeed({ tag, seq: Date.now() });
  };
  const [pixivCache, setPixivCache] = useState({});

  // Android 系统返回（边缘滑动/返回键）：先走应用内层级，最后才退出 App
  useEffect(() => {
    if (!window.Capacitor?.isNativePlatform?.()) return;
    let cleanup;
    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const listener = await App.addListener('backButton', (event) => {
          try { event.preventDefault(); } catch {}
          if (runBackHandlers()) return;
          if (event.canGoBack) {
            window.history.back();
          } else {
            App.exitApp();
          }
        });
        cleanup = () => { listener.remove(); };
      } catch { /* 非原生环境 */ }
    })();
    return () => { cleanup?.(); };
  }, []);

  // 启动时扫描相册/缓存元数据，用于"已保存绿点"与喜欢状态
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
            cached: e.state === 'cached' || e.state === 'saved',
            saved: e.isSaved,
            liked: e.isLiked,
            illustId: e.illustId,
          };
        }
        setPixivCache(patch);
      } catch { /* 忽略 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const likedSet = useMemo(() => {
    const s = new Set();
    for (const [key, val] of Object.entries(pixivCache)) {
      if (val?.liked) s.add(key);
    }
    return s;
  }, [pixivCache]);

  return (
    <div className="app">
      <main className="app-content">
        {/* 所有访问过的 tab 保持挂载（隐藏非当前页），切回不再重新加载 */}
        <div style={{ display: tab === 'discover' ? undefined : 'none' }}>
          {visitedTabs.current.has('discover') && (
            <DiscoverPage
              onOpen={openDetail}
              onOpenSettings={() => setSettingsOpen(true)}
              likedSet={likedSet}
              refreshToken={tabTokens.discover || 0}
            />
          )}
        </div>
        <div style={{ display: tab === 'ranking' ? undefined : 'none' }}>
          {visitedTabs.current.has('ranking') && (
            <RankingPage onOpen={openDetail} likedSet={likedSet} refreshToken={tabTokens.ranking || 0} />
          )}
        </div>
        <div style={{ display: tab === 'bookmarks' ? undefined : 'none' }}>
          {visitedTabs.current.has('bookmarks') && (
            <BookmarksPage
              onOpen={openDetail}
              onOpenSettings={() => setSettingsOpen(true)}
              likedSet={likedSet}
              refreshToken={tabTokens.bookmarks || 0}
            />
          )}
        </div>
        <div style={{ display: tab === 'search' ? undefined : 'none' }}>
          {visitedTabs.current.has('search') && (
            <SearchPage
              onOpen={openDetail}
              likedSet={likedSet}
              refreshToken={tabTokens.search || 0}
              searchSeed={searchSeed}
            />
          )}
        </div>
        <div style={{ display: tab === 'gallery' ? undefined : 'none' }}>
          {visitedTabs.current.has('gallery') && <GalleryPage onOpen={openDetail} likedSet={likedSet} />}
        </div>
      </main>

      <TabBar tabs={TABS} active={tab} onChange={handleTabChange} />

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {/* 详情页 — 全屏叠加层，不卸载下方 tab 页面 */}
      {detailImage && (
        <DetailView
          image={detailImage}
          pixivCache={pixivCache}
          setPixivCache={setPixivCache}
          onClose={closeDetail}
          onSearchTag={handleSearchTag}
        />
      )}

      <ToastHost />
    </div>
  );
}

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

const scrollStore = { top: 0 };

// 开发期调试入口
window.__pixivViewer = window.__pixivViewer || { storageFacade };

const TABS = [
  { key: 'discover', label: '推荐' },
  { key: 'ranking', label: '排行' },
  { key: 'bookmarks', label: '收藏' },
  { key: 'search', label: '搜索' },
  { key: 'gallery', label: '相册' },
];

const TITLES = {
  discover: 'Pixiv 推荐',
  ranking: '排行榜',
  bookmarks: '我的收藏',
  search: '搜索',
  gallery: '本地相册',
};

export default function App() {
  const [tab, setTab] = useState('ranking');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailImage, setDetailImage] = useState(null);

  const openDetail = (img) => {
    scrollStore.top = document.querySelector('.app-content')?.scrollTop || 0;
    setDetailImage(img);
  };
  const closeDetail = () => {
    setDetailImage(null);
    requestAnimationFrame(() => {
      const el = document.querySelector('.app-content');
      if (el) el.scrollTop = scrollStore.top;
    });
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
          event.preventDefault?.();
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
      <header className="app-header">
        <h1>{TITLES[tab]}</h1>
        <button className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}>⚙️</button>
      </header>

      <main className="app-content">
        {tab === 'discover' && <DiscoverPage onOpen={openDetail} onOpenSettings={() => setSettingsOpen(true)} likedSet={likedSet} />}
        {tab === 'ranking' && <RankingPage onOpen={openDetail} likedSet={likedSet} />}
        {tab === 'bookmarks' && <BookmarksPage onOpen={openDetail} onOpenSettings={() => setSettingsOpen(true)} likedSet={likedSet} />}
        {tab === 'search' && <SearchPage onOpen={openDetail} likedSet={likedSet} />}
        {tab === 'gallery' && <GalleryPage likedSet={likedSet} />}
      </main>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {/* 详情页 — 全屏叠加层，不卸载下方 tab 页面 */}
      {detailImage && (
        <DetailView
          image={detailImage}
          pixivCache={pixivCache}
          setPixivCache={setPixivCache}
          onClose={closeDetail}
        />
      )}

      <ToastHost />
    </div>
  );
}

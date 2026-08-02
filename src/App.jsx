import { useEffect, useState } from 'react';
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
import './index.css';
import './styles/detail.css';

// 开发期调试入口
window.__pixivViewer = window.__pixivViewer || { storageFacade };

const TABS = [
  { key: 'discover', label: '推荐', icon: '🧭' },
  { key: 'ranking', label: '排行', icon: '🏆' },
  { key: 'bookmarks', label: '收藏', icon: '❤️' },
  { key: 'search', label: '搜索', icon: '🔍' },
  { key: 'gallery', label: '相册', icon: '🖼️' },
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
  const [pixivCache, setPixivCache] = useState({});

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

  // 详情页打开时全屏接管
  if (detailImage) {
    return (
      <>
        <DetailView
          image={detailImage}
          pixivCache={pixivCache}
          setPixivCache={setPixivCache}
          onClose={() => setDetailImage(null)}
        />
        <ToastHost />
      </>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>{TITLES[tab]}</h1>
        <button className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}>⚙️</button>
      </header>

      <main className="app-content">
        {tab === 'discover' && <DiscoverPage onOpen={setDetailImage} />}
        {tab === 'ranking' && <RankingPage onOpen={setDetailImage} />}
        {tab === 'bookmarks' && <BookmarksPage onOpen={setDetailImage} />}
        {tab === 'search' && <SearchPage onOpen={setDetailImage} />}
        {tab === 'gallery' && <GalleryPage />}
      </main>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <ToastHost />
    </div>
  );
}

import { useState } from 'react';
import TabBar from './components/TabBar.jsx';
import ToastHost from './components/ToastHost.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import PreviewModal from './components/PreviewModal.jsx';
import DiscoverPage from './pages/DiscoverPage.jsx';
import RankingPage from './pages/RankingPage.jsx';
import BookmarksPage from './pages/BookmarksPage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import GalleryPage from './pages/GalleryPage.jsx';
import { storageFacade } from './pixiv-assistant/index.js';
import './index.css';

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
  const [preview, setPreview] = useState(null);

  return (
    <div className="app">
      <header className="app-header">
        <h1>{TITLES[tab]}</h1>
        <button className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}>⚙️</button>
      </header>

      <main className="app-content">
        {tab === 'discover' && <DiscoverPage onOpen={setPreview} />}
        {tab === 'ranking' && <RankingPage onOpen={setPreview} />}
        {tab === 'bookmarks' && <BookmarksPage onOpen={setPreview} />}
        {tab === 'search' && <SearchPage onOpen={setPreview} />}
        {tab === 'gallery' && <GalleryPage />}
      </main>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {preview && <PreviewModal item={preview} onClose={() => setPreview(null)} />}
      <ToastHost />
    </div>
  );
}

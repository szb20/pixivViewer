import { useEffect } from 'react';
import TabBar from './components/TabBar.jsx';
import ToastHost from './components/ToastHost.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import PullToRefresh from './components/PullToRefresh.jsx';
import DetailView from './components/detail/DetailView.jsx';
import AuthorWorksPage from './components/AuthorWorksPage.jsx';
import DiscoverPage from './pages/DiscoverPage.jsx';
import RankingPage from './pages/RankingPage.jsx';
import BookmarksPage from './pages/BookmarksPage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import GalleryPage from './pages/GalleryPage.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { useAppStore } from './store/useAppStore.js';
import { storageFacade } from './pixiv-assistant/index.js';
import { runBackHandlers } from './utils/backHandler.js';
import './index.css';
import './styles/detail.css';

window.__pixivViewer = window.__pixivViewer || { storageFacade };

const TABS = [
  { key: 'discover', label: '推荐' },
  { key: 'ranking', label: '排行' },
  { key: 'bookmarks', label: '收藏' },
  { key: 'search', label: '搜索' },
  { key: 'gallery', label: '喜欢' },
];

export default function App() {
  const {
    activeTab,
    visitedTabs,
    tabTokens,
    detailImage,
    authorWorks,
    searchSeed,
    settingsOpen,
    setActiveTab,
    registerRefresh,
    triggerPullRefresh,
    openDetail,
    closeDetail,
    openAuthorWorks,
    closeAuthorWorks,
    openAuthorImage,
    searchByTag,
    openSettings,
    closeSettings,
  } = useAppStore();

  useEffect(() => {
    if (!window.Capacitor?.isNativePlatform?.()) return;
    let cleanup;
    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        const listener = await App.addListener('backButton', (event) => {
          try { event.preventDefault(); } catch { }
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

  return (
    <div className="app">
      <ErrorBoundary>
        <main className="app-content">
          <div style={{ display: activeTab === 'discover' ? undefined : 'none' }}>
            {visitedTabs.has('discover') && (
              <ErrorBoundary key="discover">
                <DiscoverPage
                  onOpen={openDetail}
                  onOpenSettings={openSettings}
                  registerRefresh={registerRefresh}
                  refreshToken={tabTokens.discover || 0}
                />
              </ErrorBoundary>
            )}
          </div>
          <div style={{ display: activeTab === 'ranking' ? undefined : 'none' }}>
            {visitedTabs.has('ranking') && (
              <ErrorBoundary key="ranking">
                <RankingPage
                  onOpen={openDetail}
                  registerRefresh={registerRefresh}
                  refreshToken={tabTokens.ranking || 0}
                />
              </ErrorBoundary>
            )}
          </div>
          <div style={{ display: activeTab === 'bookmarks' ? undefined : 'none' }}>
            {visitedTabs.has('bookmarks') && (
              <ErrorBoundary key="bookmarks">
                <BookmarksPage
                  onOpen={openDetail}
                  onOpenSettings={openSettings}
                  registerRefresh={registerRefresh}
                  refreshToken={tabTokens.bookmarks || 0}
                />
              </ErrorBoundary>
            )}
          </div>
          <div style={{ display: activeTab === 'search' ? undefined : 'none' }}>
            {visitedTabs.has('search') && (
              <ErrorBoundary key="search">
                <SearchPage
                  onOpen={openDetail}
                  registerRefresh={registerRefresh}
                  refreshToken={tabTokens.search || 0}
                  searchSeed={searchSeed}
                />
              </ErrorBoundary>
            )}
          </div>
          <div style={{ display: activeTab === 'gallery' ? undefined : 'none' }}>
            {visitedTabs.has('gallery') && (
              <ErrorBoundary key="gallery">
                <GalleryPage onOpen={openDetail} registerRefresh={registerRefresh} />
              </ErrorBoundary>
            )}
          </div>
        </main>
      </ErrorBoundary>

      <div className="status-bar-frosted" />

      <PullToRefresh onRefresh={triggerPullRefresh} />

      <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} />

      {settingsOpen && <SettingsModal onClose={closeSettings} />}

      {detailImage && (
        <ErrorBoundary key="detail">
          <DetailView
            image={detailImage}
            onClose={closeDetail}
            onSearchTag={searchByTag}
            onAuthorWorks={openAuthorWorks}
          />
        </ErrorBoundary>
      )}

      {authorWorks && (
        <AuthorWorksPage
          authorId={authorWorks.authorId}
          authorName={authorWorks.authorName}
          onClose={closeAuthorWorks}
          onOpenImage={openAuthorImage}
        />
      )}

      <ToastHost />
    </div>
  );
}
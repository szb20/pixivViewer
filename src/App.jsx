import { useEffect } from 'react';
import TabBar from './components/TabBar.jsx';
import ToastHost from './components/ToastHost.jsx';
import DownloadMonitorButton from './components/DownloadMonitor.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import ProxyCheckNotice from './components/ProxyCheckNotice.jsx';
import PullToRefresh from './components/PullToRefresh.jsx';
import DetailView from './components/detail/DetailView.jsx';
import AuthorWorksPage from './components/AuthorWorksPage.jsx';
import DiscoverPage from './pages/DiscoverPage.jsx';
import RankingPage from './pages/RankingPage.jsx';
import SearchPage from './pages/SearchPage.jsx';
import MePage from './pages/MePage.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { useAppStore } from './store/useAppStore.js';
import { storageFacade } from './pixiv-assistant/index.js';
import { runBackHandlers } from './utils/backHandler.js';
import { checkProxyReachable } from './utils/proxyCheck.js';
import { createLogger } from './utils/logger.js';
import './index.css';
import './styles/detail.css';

window.__pixivViewer = window.__pixivViewer || { storageFacade };

const TABS = [
  { key: 'discover', label: '推荐' },
  { key: 'ranking', label: '排行' },
  { key: 'search', label: '搜索' },
  { key: 'me', label: '我' },
];

const log = createLogger('App');

export default function App() {
  const {
    activeTab,
    visitedTabs,
    tabTokens,
    detailImage,
    authorWorks,
    searchSeed,
    settingsOpen,
    showProxyError,
    proxyCheckUrl,
    setActiveTab,
    registerRefresh,
    triggerPullRefresh,
    openDetail,
    closeDetail,
    exitToHome,
    openAuthorWorks,
    closeAuthorWorks,
    openAuthorImage,
    searchByTag,
    openSettings,
    closeSettings,
    setShowProxyError,
  } = useAppStore();

  useEffect(() => {
    if (!window.Capacitor?.isNativePlatform?.()) return;
    let cancelled = false;
    let listener;
    (async () => {
      try {
        const { App } = await import('@capacitor/app');
        if (cancelled) return;
        listener = await App.addListener('backButton', (event) => {
          try { event.preventDefault(); } catch { }
          if (runBackHandlers()) return;
          if (event.canGoBack) {
            window.history.back();
          } else {
            App.exitApp();
          }
        });
      } catch { /* 非原生环境 */ }
    })();
    return () => {
      cancelled = true;
      listener?.remove?.();
    };
  }, []);

  // 启动时代理连通性检测
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { reachable, proxyUrl } = await checkProxyReachable(3000);
        if (cancelled) return;
        if (!reachable) {
          setShowProxyError(true, proxyUrl);
        }
      } catch (e) {
        log.warn('启动时代理检测异常:', e?.message || e);
      }
    })();
    return () => { cancelled = true; };
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
          <div style={{ display: activeTab === 'search' ? undefined : 'none' }}>
            {visitedTabs.has('search') && (
              <ErrorBoundary key="search">
                <SearchPage
                  active={activeTab === 'search'}
                  onOpen={openDetail}
                  registerRefresh={registerRefresh}
                  refreshToken={tabTokens.search || 0}
                  searchSeed={searchSeed}
                />
              </ErrorBoundary>
            )}
          </div>
          <div style={{ display: activeTab === 'me' ? undefined : 'none' }}>
            {visitedTabs.has('me') && (
              <ErrorBoundary key="me">
                <MePage
                  active={activeTab === 'me'}
                  showSettingsBtn={activeTab === 'me' && !detailImage && !authorWorks}
                  onOpen={openDetail}
                  onOpenSettings={openSettings}
                  onAuthorWorks={openAuthorWorks}
                  registerRefresh={registerRefresh}
                  refreshToken={tabTokens.me || 0}
                />
              </ErrorBoundary>
            )}
          </div>
        </main>
      </ErrorBoundary>

      <div className="status-bar-frosted" />

      <PullToRefresh onRefresh={triggerPullRefresh} />

      <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} />

      {settingsOpen && <SettingsPage onClose={closeSettings} />}

      {showProxyError && (
        <ProxyCheckNotice
          proxyUrl={proxyCheckUrl}
          onOpenSettings={openSettings}
          onDismiss={() => setShowProxyError(false)}
        />
      )}

      {detailImage && (
        <ErrorBoundary key="detail">
          <DetailView
            image={detailImage}
            onClose={closeDetail}
            onExitToHome={exitToHome}
            onSearchTag={searchByTag}
            onAuthorWorks={openAuthorWorks}
          />
        </ErrorBoundary>
      )}

      {authorWorks && (
        <AuthorWorksPage
          authorId={authorWorks.authorId}
          authorName={authorWorks.authorName}
          authorAvatar={authorWorks.authorAvatar}
          onClose={closeAuthorWorks}
          onOpenImage={openAuthorImage}
        />
      )}

      <ToastHost />
      <DownloadMonitorButton />
    </div>
  );
}

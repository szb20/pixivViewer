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
import { useAndroidBackButton } from './hooks/useAndroidBackButton.js';
import { useChromeAutoHide } from './hooks/useChromeAutoHide.js';
import { useStartupProxyCheck } from './hooks/useStartupProxyCheck.js';
import { restoreMainScrollOnColdStart } from './utils/scroll.js';
import './index.css';
import './styles/detail.css';

if (import.meta.env.DEV) {
  window.__pixivViewer = window.__pixivViewer || { storageFacade };
}

const TABS = [
  { key: 'discover', label: '推荐' },
  { key: 'ranking', label: '排行' },
  { key: 'me', label: '我' },
  { key: 'search', label: '搜索' },
];

export default function App() {
  const [chromeHidden] = useChromeAutoHide();
  useAndroidBackButton();
  const {
    activeTab,
    visitedTabs,
    tabTokens,
    detailImage,
    detailContext,
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

  // 启动时代理连通性检测（zustand action 引用稳定，可直接作为回调传入）
  useStartupProxyCheck(setShowProxyError);

  // 冷启动恢复上次离开时的滚动位置（页面快照）
  useEffect(() => {
    const { scrollPositions, activeTab: tab } = useAppStore.getState();
    restoreMainScrollOnColdStart(scrollPositions?.[tab] || 0);
  }, []);

  return (
    <div className={`app${chromeHidden ? ' chrome-hidden' : ''}`}>
      <ErrorBoundary>
        <main className="app-content">
          <div className="tab-pane" style={{ display: activeTab === 'discover' ? undefined : 'none' }}>
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
          <div className="tab-pane" style={{ display: activeTab === 'ranking' ? undefined : 'none' }}>
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
          <div className="tab-pane" style={{ display: activeTab === 'search' ? undefined : 'none' }}>
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
          <div className="tab-pane" style={{ display: activeTab === 'me' ? undefined : 'none' }}>
            {visitedTabs.has('me') && (
              <ErrorBoundary key="me">
                <MePage
                  active={activeTab === 'me'}
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

      <TabBar tabs={TABS} active={activeTab} onChange={setActiveTab} hidden={chromeHidden} />

      {!settingsOpen && !detailImage && !authorWorks && (
        <button
          className={`glass-icon-btn me-settings-btn${chromeHidden ? ' me-settings-btn--hidden' : ''}`}
          onClick={openSettings}
          aria-label="设置"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}

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
            navContext={detailContext}
            onClose={closeDetail}
            onExitToHome={exitToHome}
            onSearchTag={searchByTag}
            onAuthorWorks={openAuthorWorks}
          />
        </ErrorBoundary>
      )}

      {authorWorks && (
        /* 详情打开时隐藏作者页而非卸载，保住 <img> 不重载 */
        <div style={detailImage ? { display: 'none' } : undefined}>
          <AuthorWorksPage
            authorId={authorWorks.authorId}
            authorName={authorWorks.authorName}
            authorAvatar={authorWorks.authorAvatar}
            onClose={closeAuthorWorks}
            onOpenImage={openAuthorImage}
          />
        </div>
      )}

      <ToastHost />
      <DownloadMonitorButton />
    </div>
  );
}
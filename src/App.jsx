import { useEffect } from 'react';
import TabBar from './components/TabBar.jsx';
import SideNav from './components/SideNav.jsx';
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
import { downloadMonitor } from './utils/downloadMonitor.js';
import { useAndroidBackButton } from './hooks/useAndroidBackButton.js';
import { useIsDesktop } from './hooks/useIsDesktop.js';
import { useChromeAutoHide } from './hooks/useChromeAutoHide.js';
import { useStartupProxyCheck } from './hooks/useStartupProxyCheck.js';
import { useImageSourceId } from './hooks/useImageSource.js';
import { restoreMainScrollOnColdStart } from './utils/scroll.js';
import './index.css';
import './styles/detail.css';

if (import.meta.env.DEV) {
  window.__pixivViewer = window.__pixivViewer || {
    storageFacade,
    openDetail: useAppStore.getState().openDetail,
    // 调试用：run-desktop 驱动靠它注入假的下载任务，
    // 验证下载管理的分组与「已下载/总大小 · 速度」显示（真下载会弹原生保存框，没法自动化）
    downloadMonitor,
  };
}

const TABS = [
  { key: 'discover', label: '推荐' },
  { key: 'ranking', label: '排行' },
  { key: 'me', label: '我' },
  { key: 'search', label: '搜索' },
];

/** tab key → 页面组件。与 TABS 同序，加 tab 只需在这里补一行 */
const TAB_PAGES = {
  discover: DiscoverPage,
  ranking: RankingPage,
  me: MePage,
  search: SearchPage,
};

export default function App() {
  const [chromeHidden] = useChromeAutoHide();
  useAndroidBackButton();
  const isDesktop = useIsDesktop();
  // 全局来源：切换时 tab-pane 的 key 变化 → 整块重挂载，
  // 列表 / 翻页游标 / 滚动位置 / 内存缓存全部天然重置（否则会残留另一站的列表）。
  const activeSource = useImageSourceId();
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
    openSearchComposer,
    closeSearchComposer,
  } = useAppStore();

  // 各 tab 的 props：共用项走 base，差异项在这里补。
  // 集中一处，省掉「每加一个 tab 就复制一段保活 JSX + 对齐 props」。
  const tabProps = (key) => {
    const base = {
      active: activeTab === key,
      onOpen: openDetail,
      registerRefresh,
      refreshToken: tabTokens[key] || 0,
    };
    switch (key) {
      case 'discover': return { ...base, onOpenSettings: openSettings };
      case 'search': return { ...base, searchSeed };
      case 'me': return { ...base, onOpenSettings: openSettings, onAuthorWorks: openAuthorWorks };
      default: return base;
    }
  };

  // 启动时代理连通性检测（zustand action 引用稳定，可直接作为回调传入）
  useStartupProxyCheck(setShowProxyError);

  // 桌面端侧边栏「搜索」：不跳页，先在当前页面上浮出搜索框，提交后才切到结果页。
  // 结果页已经开着时沿用「重点当前项 = 刷新列表」的既有语义；
  // !isDesktop 分支是给「侧边栏在手机宽度下 display:none 但仍在 DOM」的兜底。
  const handleSearchNav = () => {
    if (!isDesktop || activeTab === 'search') {
      setActiveTab('search');
      return;
    }
    openSearchComposer();
  };

  // 窗口跨到手机宽度：桌面专属的搜索唤起态要收掉，免得切回来时残留
  useEffect(() => {
    if (!isDesktop) closeSearchComposer();
  }, [isDesktop, closeSearchComposer]);

  // 冷启动恢复上次离开时的滚动位置（页面快照）
  useEffect(() => {
    const { scrollPositions, activeTab: tab } = useAppStore.getState();
    restoreMainScrollOnColdStart(scrollPositions?.[tab] || 0);
  }, []);

  return (
    <div className={`app${chromeHidden ? ' chrome-hidden' : ''}`}>
      {/* 桌面左侧边栏；手机端由 CSS 隐藏，走下面的底部 TabBar */}
      <SideNav
        tabs={TABS}
        active={activeTab}
        onChange={setActiveTab}
        onOpenSettings={openSettings}
        onSearchNav={handleSearchNav}
      />

      <ErrorBoundary>
        <main className="app-content">
          {TABS.map(({ key }) => {
            const Page = TAB_PAGES[key];
            return (
              <div key={key} className="tab-pane" style={{ display: activeTab === key ? undefined : 'none' }}>
                {/* 按来源 key 重挂载：切换来源时列表 / 游标 / 滚动 / 内存缓存一起重置。
                    桌面端搜索面板启动即挂载（保持隐藏）：它的 portal 搜索框要在任意页面都能被唤起 */}
                {(visitedTabs.has(key) || (isDesktop && key === 'search')) && (
                  <ErrorBoundary key={`${activeSource}:${key}`}>
                    <Page {...tabProps(key)} />
                  </ErrorBoundary>
                )}
              </div>
            );
          })}
        </main>
      </ErrorBoundary>

      <div className={`status-bar-frosted${chromeHidden ? ' status-bar-frosted--hidden' : ''}`} />

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
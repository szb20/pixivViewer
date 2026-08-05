import { useCallback, useEffect, useRef, useState } from 'react';
import SubTabBar from '../components/SubTabBar.jsx';
import FollowingPanel from '../components/panels/FollowingPanel.jsx';
import FollowingAuthorsPanel from '../components/panels/FollowingAuthorsPanel.jsx';
import LikedPanel from '../components/panels/LikedPanel.jsx';
import BookmarksPanel from '../components/panels/BookmarksPanel.jsx';
import '../styles/me.css';

const SUB_TABS = [
  { key: 'following',     label: '关注' },
  { key: 'subscriptions', label: '订阅' },
  { key: 'liked',         label: '喜欢' },
  { key: 'bookmarks',     label: '收藏' },
];

/**
 * "我"页面：聚合 关注/喜欢/订阅 三个子面板。
 *
 * 刷新策略（下拉刷新 + 双击"我" tab）只作用于当前活跃子面板：
 * - 各子面板通过 onReportLoad 上报自己的 load（useTabFeed 返回，稳定引用）
 * - MePage 在 'me' 键上注册一个聚合刷新回调，转发给当前活跃子面板
 * - 不把 registerRefresh / refreshToken 透传给子面板，避免三面板互相覆盖或全量刷新
 */
export default function MePage({ active, showSettingsBtn, onOpen, onOpenSettings, onAuthorWorks, registerRefresh, refreshToken }) {
  const [subTab, setSubTab] = useState('liked');
  const [visitedSubs, setVisitedSubs] = useState(() => new Set(['liked']));
  // 子标签栏显隐：仿照排行页筛选栏，下滑隐藏、双击"我"tab 切换
  const [showBar, setShowBar] = useState(true);
  const subTabRef = useRef(subTab);
  subTabRef.current = subTab;
  const panelLoadsRef = useRef({});

  const reportLoad = useCallback((key, load) => {
    panelLoadsRef.current[key] = load;
  }, []);

  // 每次切回"我"tab 都默认弹出子标签栏（避免上次下滑隐藏的状态残留）
  useEffect(() => {
    if (active) setShowBar(true);
  }, [active]);

  // 在 'me' 键上注册聚合刷新：下拉刷新只触发当前活跃子面板
  useEffect(() => {
    if (!registerRefresh) return;
    return registerRefresh('me', () => {
      const fn = panelLoadsRef.current[subTabRef.current];
      return fn?.();
    });
  }, [registerRefresh]);

  // 双击"我" tab（refreshToken 变化）→ 切换子标签栏显隐 + 刷新当前活跃子面板
  useEffect(() => {
    if (refreshToken > 0) {
      setShowBar(v => !v);
      panelLoadsRef.current[subTabRef.current]?.();
    }
  }, [refreshToken]);

  // 仅"用户主动下滑"隐藏子标签栏：用 touchmove/wheel 判定，
  // 切 tab 时恢复滚动位置是程序化的（不产生 touchmove/wheel），不会误隐藏。
  useEffect(() => {
    const el = document.querySelector('.app-content');
    if (!el) return;
    // 手势起点：一次触摸/滚动会话内，滚动超过起点 +20px 视为下滑
    let gestureStart = el.scrollTop;
    const onTouchStart = () => { gestureStart = el.scrollTop; };
    const onTouchMove = () => {
      if (el.scrollTop > gestureStart + 20) setShowBar(false);
    };
    const onWheel = (e) => {
      if (e.deltaY > 0) setShowBar(false);
    };
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  const switchSubTab = (key) => {
    setVisitedSubs(v => { const n = new Set(v); n.add(key); return n; });
    setSubTab(key);
  };

  return (
    <div className="page me-page">
      <SubTabBar tabs={SUB_TABS} active={subTab} onChange={switchSubTab} hidden={!showBar} />

      {active && showSettingsBtn && (
        <button
          className="glass-icon-btn me-settings-btn"
          onClick={onOpenSettings}
          aria-label="设置"
        >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      )}

      <div className="me-panels">
        {visitedSubs.has('following') && (
          <div style={{ display: subTab === 'following' ? undefined : 'none' }}>
            <FollowingPanel
              onOpen={onOpen}
              onOpenSettings={onOpenSettings}
              onReportLoad={reportLoad}
            />
          </div>
        )}
        {visitedSubs.has('subscriptions') && (
          <div style={{ display: subTab === 'subscriptions' ? undefined : 'none' }}>
            <FollowingAuthorsPanel
              onOpen={onOpen}
              onOpenAuthor={onAuthorWorks}
              onOpenSettings={onOpenSettings}
              onReportLoad={reportLoad}
            />
          </div>
        )}
        {visitedSubs.has('liked') && (
          <div style={{ display: subTab === 'liked' ? undefined : 'none' }}>
            <LikedPanel
              onOpen={onOpen}
              onReportLoad={reportLoad}
            />
          </div>
        )}
        {visitedSubs.has('bookmarks') && (
          <div style={{ display: subTab === 'bookmarks' ? undefined : 'none' }}>
            <BookmarksPanel
              onOpen={onOpen}
              onOpenSettings={onOpenSettings}
              onReportLoad={reportLoad}
            />
          </div>
        )}
      </div>
    </div>
  );
}

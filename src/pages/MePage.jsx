import { useCallback, useEffect, useRef, useState } from 'react';
import SubTabBar from '../components/SubTabBar.jsx';
import FollowingPanel from '../components/panels/FollowingPanel.jsx';
import FollowingAuthorsPanel from '../components/panels/FollowingAuthorsPanel.jsx';
import LikedPanel from '../components/panels/LikedPanel.jsx';
import BookmarksPanel from '../components/panels/BookmarksPanel.jsx';
import { getMainScrollEl } from '../utils/scroll.js';
import '../styles/me.css';

const SUB_TABS = [
  { key: 'following', label: '关注' },
  { key: 'subscriptions', label: '订阅' },
  { key: 'liked', label: '喜欢' },
  { key: 'bookmarks', label: '收藏' },
];

/**
 * "我"页面：聚合 关注/喜欢/订阅 三个子面板。
 *
 * 刷新策略（下拉刷新 + 双击"我" tab）只作用于当前活跃子面板：
 * - 各子面板通过 onReportLoad 上报自己的 load（useTabFeed 返回，稳定引用）
 * - MePage 在 'me' 键上注册一个聚合刷新回调，转发给当前活跃子面板
 * - 不把 registerRefresh / refreshToken 透传给子面板，避免三面板互相覆盖或全量刷新
 */
export default function MePage({ active, onOpen, onOpenSettings, onAuthorWorks, registerRefresh, refreshToken }) {
  const [subTab, setSubTab] = useState('liked');
  const [visitedSubs, setVisitedSubs] = useState(() => new Set(['liked']));
  // 子页签切换动画：旧面板淡出后再隐藏
  const [subAnim, setSubAnim] = useState(null);
  // 二级菜单显隐：下滑隐藏、上滑显示、回到顶部强制显示
  const [showBar, setShowBar] = useState(true);
  const subTabRef = useRef(subTab);
  subTabRef.current = subTab;
  const panelLoadsRef = useRef({});

  const reportLoad = useCallback((key, load) => {
    panelLoadsRef.current[key] = load;
  }, []);

  // 每次切回"我" tab 都默认弹出二级菜单
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

  // 点击当前"我" tab（refreshToken 变化）→ 刷新当前活跃子面板
  useEffect(() => {
    if (refreshToken > 0) {
      panelLoadsRef.current[subTabRef.current]?.();
    }
  }, [refreshToken]);

  // 二级菜单显隐与主 TabBar 一致：下滑隐藏、上滑显示、回到顶部强制显示。
  // 用 touchmove/wheel 判定，切 tab 时恢复滚动位置是程序化的（不产生 touchmove/wheel），不会误触发。
  useEffect(() => {
    const el = getMainScrollEl();
    if (!el) return;
    let gestureStart = el.scrollTop;
    const onTouchStart = () => { gestureStart = el.scrollTop; };
    const onTouchMove = () => {
      const top = el.scrollTop;
      if (top < 24) setShowBar(true);
      else if (top > gestureStart + 20) setShowBar(false);
      else if (top < gestureStart - 20) setShowBar(true);
    };
    const onWheel = (e) => {
      if (e.deltaY > 0) setShowBar(false);
      else if (e.deltaY < 0) setShowBar(true);
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
    if (key === subTab) return;
    setSubAnim({ from: subTab });
    setVisitedSubs(v => { const n = new Set(v); n.add(key); return n; });
    setSubTab(key);
    window.setTimeout(() => setSubAnim(null), 240);
  };

  const subPaneVisible = (key) => key === subTab || (subAnim && key === subAnim.from);
  const subPaneCls = (key) => (
    subAnim && key === subAnim.from
      ? 'tab-pane tab-pane--fade-out'
      : (subAnim && key === subTab ? 'tab-pane tab-pane--fade-in' : 'tab-pane')
  );

  return (
    <div className="page me-page">
      <SubTabBar tabs={SUB_TABS} active={subTab} onChange={switchSubTab} hidden={!showBar} />

      <div className="me-panels">
        {visitedSubs.has('following') && (
          <div className={subPaneCls('following')} style={{ display: subPaneVisible('following') ? undefined : 'none' }}>
            <FollowingPanel
              onOpen={onOpen}
              onOpenSettings={onOpenSettings}
              onReportLoad={reportLoad}
            />
          </div>
        )}
        {visitedSubs.has('subscriptions') && (
          <div className={subPaneCls('subscriptions')} style={{ display: subPaneVisible('subscriptions') ? undefined : 'none' }}>
            <FollowingAuthorsPanel
              onOpen={onOpen}
              onOpenAuthor={onAuthorWorks}
              onOpenSettings={onOpenSettings}
              onReportLoad={reportLoad}
            />
          </div>
        )}
        {visitedSubs.has('liked') && (
          <div className={subPaneCls('liked')} style={{ display: subPaneVisible('liked') ? undefined : 'none' }}>
            <LikedPanel
              onOpen={onOpen}
              onReportLoad={reportLoad}
            />
          </div>
        )}
        {visitedSubs.has('bookmarks') && (
          <div className={subPaneCls('bookmarks')} style={{ display: subPaneVisible('bookmarks') ? undefined : 'none' }}>
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
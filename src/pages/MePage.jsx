import { useCallback, useEffect, useRef, useState } from 'react';
import FollowingPanel from '../components/panels/FollowingPanel.jsx';
import FollowingAuthorsPanel from '../components/panels/FollowingAuthorsPanel.jsx';
import LikedPanel from '../components/panels/LikedPanel.jsx';
import BookmarksPanel from '../components/panels/BookmarksPanel.jsx';
import { useImageSourceId } from '../hooks/useImageSource.js';
import { getMeSubTabs, clampMeSubTab } from '../utils/meTabs.js';
import { useAppStore } from '../store/useAppStore.js';
import '../styles/me.css';

/**
 * "我"页面：聚合 关注/喜欢/订阅 三个子面板。
 *
 * 刷新策略（下拉刷新 + 双击"我" tab）只作用于当前活跃子面板：
 * - 各子面板通过 onReportLoad 上报自己的 load（useTabFeed 返回，稳定引用）
 * - MePage 在 'me' 键上注册一个聚合刷新回调，转发给当前活跃子面板
 * - 不把 registerRefresh / refreshToken 透传给子面板，避免三面板互相覆盖或全量刷新
 *
 * 子页签的当前值放在 store（侧边栏 / 抽屉也要驱动它），本组件只保留
 * 保活集合 visitedSubs 与切换动画 —— 两者都跟随 store 值派生。
 */
export default function MePage({ onOpen, onOpenSettings, onAuthorWorks, registerRefresh, refreshToken }) {
  const sourceId = useImageSourceId();
  const tabs = getMeSubTabs(sourceId);
  const rawSubTab = useAppStore(s => s.meSubTab);
  // 切来源会按 key 重挂载本页，但 meSubTab 留在 store 里，这里按当前来源可用项兜底（见 clampMeSubTab）
  const subTab = clampMeSubTab(tabs, rawSubTab);
  const [visitedSubs, setVisitedSubs] = useState(() => new Set([subTab]));
  // 子页签切换动画：旧面板淡出后再隐藏
  const [subAnim, setSubAnim] = useState(null);
  const subTabRef = useRef(subTab);
  subTabRef.current = subTab;
  const panelLoadsRef = useRef({});

  // 面板保活：切到过的子页签都留在 DOM 里（display:none），回来时不重新拉数据
  useEffect(() => {
    setVisitedSubs(v => (v.has(subTab) ? v : new Set(v).add(subTab)));
  }, [subTab]);

  // 切换动画改为监听 store 值变化 —— 这样侧边栏驱动和页内点选走的是同一条路径
  const prevSubRef = useRef(subTab);
  useEffect(() => {
    if (prevSubRef.current === subTab) return;
    setSubAnim({ from: prevSubRef.current });
    prevSubRef.current = subTab;
    const t = window.setTimeout(() => setSubAnim(null), 240);
    return () => window.clearTimeout(t);
  }, [subTab]);

  const reportLoad = useCallback((key, load) => {
    panelLoadsRef.current[key] = load;
  }, []);

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

  const subPaneVisible = (key) => key === subTab || (subAnim && key === subAnim.from);
  const subPaneCls = (key) => (
    subAnim && key === subAnim.from
      ? 'tab-pane tab-pane--fade-out'
      : (subAnim && key === subTab ? 'tab-pane tab-pane--fade-in' : 'tab-pane')
  );

  return (
    <div className="page">
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
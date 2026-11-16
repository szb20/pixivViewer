import { useCallback, useEffect, useRef } from 'react';
import FollowingPanel from '../components/panels/FollowingPanel.jsx';
import XFollowingPanel from '../components/panels/XFollowingPanel.jsx';
import FollowingAuthorsPanel from '../components/panels/FollowingAuthorsPanel.jsx';
import LikedPanel from '../components/panels/LikedPanel.jsx';
import BookmarksPanel from '../components/panels/BookmarksPanel.jsx';
import { useImageSourceId } from '../hooks/useImageSource.js';
import '../styles/me.css';

/**
 * 「我」拆开后各面板（关注/订阅/喜欢/收藏）的通用顶级 tab 宿主。
 *
 * 本组件按 panelKey + 来源渲染对应面板，并承担页面宿主的两件事：
 *  - 把面板经 onReportLoad 上报的 load 注册到本 tab 键上（下拉刷新用）；
 *  - 双击当前 tab（refreshToken 变化）→ 刷新面板。
 * 页面保活（App 的 visitedTabs tab-pane）与切来源重挂载（ErrorBoundary key）都在 App 层。
 */
export default function SubTabPage({
  panelKey, onOpen, onOpenSettings, onAuthorWorks, registerRefresh, refreshToken,
}) {
  const sourceId = useImageSourceId();
  const loadRef = useRef(null);

  // 面板上报的 load 引用（面板自带稳定引用，挂载时上报一次）
  const reportLoad = useCallback((_key, load) => {
    loadRef.current = load;
  }, []);

  useEffect(() => {
    if (!registerRefresh) return;
    return registerRefresh(panelKey, () => loadRef.current?.());
  }, [registerRefresh, panelKey]);

  // 双击当前 tab = 刷新。跳过挂载那一次：切来源会整块重挂载本页，
  // 此时 token 往往已 > 0，照单全收会在水合/首拉之外多发一次重复请求。
  const lastTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (refreshToken > 0 && refreshToken !== lastTokenRef.current) {
      loadRef.current?.();
    }
    lastTokenRef.current = refreshToken;
  }, [refreshToken]);

  let panel = null;
  if (panelKey === 'following') {
    // 同名 tab 按来源分流：X 是自己的关注时间线，其余走 Pixiv 关注流
    panel = sourceId === 'twitter'
      ? <XFollowingPanel onOpen={onOpen} onReportLoad={reportLoad} />
      : <FollowingPanel onOpen={onOpen} onOpenSettings={onOpenSettings} onReportLoad={reportLoad} />;
  } else if (panelKey === 'subscriptions') {
    panel = (
      <FollowingAuthorsPanel
        onOpen={onOpen}
        onOpenAuthor={onAuthorWorks}
        onOpenSettings={onOpenSettings}
        onReportLoad={reportLoad}
      />
    );
  } else if (panelKey === 'liked') {
    panel = <LikedPanel onOpen={onOpen} onReportLoad={reportLoad} />;
  } else if (panelKey === 'bookmarks') {
    panel = <BookmarksPanel onOpen={onOpen} onOpenSettings={onOpenSettings} onReportLoad={reportLoad} />;
  }

  return <div className="page">{panel}</div>;
}

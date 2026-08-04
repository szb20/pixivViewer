# "我"页面重构设计方案

> 版本：v1.0 · 日期：2026-08-04 · 状态：待实施

---

## 1. 目标

将当前底部 Tab 栏从 5 个精简为 4 个，最后一页改为"我"，聚合个人相关功能：

```
推荐  |  排行  |  搜索  |  我
```

---

## 2. 变更概览

```
之前（5 tabs）                          之后（4 tabs）
┌──────────────────────────┐           ┌──────────────────────────┐
│  推荐 │ 排行 │ 收藏 │ 搜索 │ 喜欢    │  推荐 │ 排行 │ 搜索 │  我   │
└──────────────────────────┘           └──────────────────────────┘

"收藏" + "喜欢" → 合并进"我"的子 Tab         ↑
```

**"我"页面内部结构：**

```
┌─────────────────────────────────┐
│                                 │
│      主内容区（作品网格）         │
│                                 │
├─────────────────────────────────┤  ← 毛玻璃分割线
│     关注   │   喜欢   │   订阅   │  ← SubTabBar
├─────────────────────────────────┤
│    推荐  │  排行  │  搜索  │  我  │  ← 主 TabBar
└─────────────────────────────────┘
```

---

## 3. 三个子 Tab 的数据语义

| 子标签 | 图标素材 | 数据来源 | 含义 |
|--------|---------|---------|------|
| **关注** | `@` | `pixivApi.fetchFollowing()` | 我关注的所有画师更新的最新插画作品（按时间排序） |
| **喜欢** | `♥` | `storageFacade.listLiked()` | 我在本地点过❤️的作品（私有，存 IndexedDB） |
| **订阅** | `☆` | `pixivApi.fetchBookmarks()` | 我在 Pixiv 上收藏/订阅的公开作品 |

**命名解释：**
- "关注" = Following（看的是人 → 关注画师的作品流）
- "喜欢" = Liked（本地的、私有的点赞记录）
- "订阅" = Bookmarks（Pixiv 公开收藏夹，Pixiv 官方术语就是"ブックマーク"）

> **关于"关注的用户列表"：** `fetchFollowing` 当前返回的是关注画师的**最新插画作品**，不是用户列表。如果未来需要展示"我关注了哪些人"这种用户列表视图，需要新增 `/ajax/user/:id/following` API。当前方案先用作品流。

---

## 4. 文件变更

| 操作 | 文件 | 变更说明 |
|------|------|----------|
| ✏️ 修改 | `src/App.jsx` | TABS 数 5→4；用 `MePage` 替换 `BookmarksPage` + `GalleryPage` |
| ✏️ 修改 | `src/store/useAppStore.js` | 同步 TABS 定义 |
| ✏️ 修改 | `src/components/TabBar.jsx` | 无逻辑变更（纯 props 驱动） |
| ✨ 新增 | `src/pages/MePage.jsx` | 聚合页面：SubTabBar + 三个子面板 |
| ✨ 新增 | `src/components/SubTabBar.jsx` | 子标签栏（下划线指示器风格） |
| ✨ 新增 | `src/components/panels/FollowingPanel.jsx` | 关注画师作品面板 |
| ✨ 新增 | `src/components/panels/LikedPanel.jsx` | 本地喜欢面板（从 GalleryPage 提取） |
| ✨ 新增 | `src/components/panels/BookmarksPanel.jsx` | Pixiv 收藏面板（从 BookmarksPage 提取） |
| ✨ 新增 | `src/styles/me.css` | "我"页面及子标签样式 |
| 🗑️ 移除 | `src/pages/BookmarksPage.jsx` | 逻辑已提取到 BookmarksPanel |
| 🗑️ 移除 | `src/pages/GalleryPage.jsx` | 逻辑已提取到 LikedPanel |
| ✏️ 修改 | `src/index.css` | 新增 `sub-tab-bar` 相关全局样式 |

---

## 5. 组件层级

```
App.jsx
├── DiscoverPage                             (Tab 0: 推荐)
├── RankingPage                              (Tab 1: 排行)
├── SearchPage                               (Tab 2: 搜索)
└── MePage                                   (Tab 3: 我)
    ├── SubTabBar
    │   ├── <button> 关注 </button>
    │   ├── <button> 喜欢 </button>
    │   └── <button> 订阅 </button>
    │   └── <div> 下划线指示器 </div>
    └── <div className="me-panels">
        ├── FollowingPanel                   (display 切换)
        │   └── ImageGrid + useTabFeed
        ├── LikedPanel                       (display 切换)
        │   └── gallery-grid + useTabFeed
        └── BookmarksPanel                   (display 切换)
            └── ImageGrid + useTabFeed
```

> 三个 Panel 之间用 `display: none/block` 切换（保持滚动位置），效果同 App.jsx 中各 Tab 的懒挂载机制。

---

## 6. 各组件伪代码

### 6.1 MePage.jsx（新增）

```jsx
import { useState } from 'react';
import SubTabBar from '../components/SubTabBar.jsx';
import FollowingPanel from '../components/panels/FollowingPanel.jsx';
import LikedPanel from '../components/panels/LikedPanel.jsx';
import BookmarksPanel from '../components/panels/BookmarksPanel.jsx';
import '../styles/me.css';

const SUB_TABS = [
  { key: 'following', label: '关注' },
  { key: 'liked',     label: '喜欢' },
  { key: 'bookmarks', label: '订阅' },
];

export default function MePage({ onOpen, onOpenSettings, registerRefresh, refreshToken }) {
  const [subTab, setSubTab] = useState('liked');
  const [visitedSubs, setVisitedSubs] = useState(new Set(['liked']));

  const switchSubTab = (key) => {
    setVisitedSubs(v => { const n = new Set(v); n.add(key); return n; });
    setSubTab(key);
  };

  return (
    <div className="page me-page">
      <SubTabBar tabs={SUB_TABS} active={subTab} onChange={switchSubTab} />

      <div className="me-panels">
        {visitedSubs.has('following') && (
          <div style={{ display: subTab === 'following' ? undefined : 'none' }}>
            <FollowingPanel
              onOpen={onOpen}
              registerRefresh={registerRefresh}
              refreshToken={refreshToken}
            />
          </div>
        )}
        {visitedSubs.has('liked') && (
          <div style={{ display: subTab === 'liked' ? undefined : 'none' }}>
            <LikedPanel
              onOpen={onOpen}
              registerRefresh={registerRefresh}
              refreshToken={refreshToken}
            />
          </div>
        )}
        {visitedSubs.has('bookmarks') && (
          <div style={{ display: subTab === 'bookmarks' ? undefined : 'none' }}>
            <BookmarksPanel
              onOpen={onOpen}
              onOpenSettings={onOpenSettings}
              registerRefresh={registerRefresh}
              refreshToken={refreshToken}
            />
          </div>
        )}
      </div>
    </div>
  );
}
```

### 6.2 SubTabBar.jsx（新增）

```jsx
import { useRef, useEffect, useState } from 'react';

export default function SubTabBar({ tabs, active, onChange }) {
  const containerRef = useRef(null);
  const activeRef = useRef(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  useEffect(() => {
    const container = containerRef.current;
    const activeEl = activeRef.current;
    if (!container || !activeEl) return;
    const cr = container.getBoundingClientRect();
    const ar = activeEl.getBoundingClientRect();
    setIndicatorStyle({
      left: ar.left - cr.left,
      width: ar.width,
    });
  }, [active]);

  return (
    <div className="sub-tab-bar" ref={containerRef}>
      {tabs.map(t => (
        <button
          key={t.key}
          ref={t.key === active ? activeRef : null}
          className={`sub-tab-btn${t.key === active ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
      <div
        className="sub-tab-indicator"
        style={{
          transform: `translateX(${indicatorStyle.left}px)`,
          width: `${indicatorStyle.width}px`,
        }}
      />
    </div>
  );
}
```

### 6.3 FollowingPanel.jsx（新增）

```jsx
import { useRef } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { useTabFeed } from '../../hooks/useTabFeed.js';
import { useLikedSet } from '../../context/pixivCacheContext.js';
import ImageGrid from '../ImageGrid.jsx';
import NeedCookieNotice from '../NeedCookieNotice.jsx';

const PAGE_SIZE = 48;
const CACHE_KEY = 'me_following';

export default function FollowingPanel({ onOpen, onOpenSettings, registerRefresh, refreshToken }) {
  const likedSet = useLikedSet();
  const pageRef = useRef(1);

  const feed = useTabFeed({
    cacheKey: CACHE_KEY,
    registerRefresh,
    refreshToken,
    hydrate: (cache) => {
      if (!cache?.items?.length) return null;
      if (cache.page > 1) pageRef.current = cache.page;
      return { items: cache.items, hasMore: !!cache.hasMore };
    },
    fetchPage: async (append) => {
      if (!append) pageRef.current = 1;
      const r = await pixivApi.fetchFollowing({ page: pageRef.current });
      const list = r?.illusts || [];
      pageRef.current += 1;
      return {
        list,
        hasMore: list.length >= PAGE_SIZE,
        emptyMessage: '未关注任何画师',
        cacheExtra: { page: pageRef.current },
      };
    },
  });

  const needCookie = !!feed.error && /cookie|no_cookie|需要.*Cookie/i.test(feed.error);

  if (needCookie) {
    return <NeedCookieNotice onOpenSettings={onOpenSettings} />;
  }

  return (
    <>
      {feed.error && (
        <div className="error-box">
          {feed.error}
          <button className="error-retry" onClick={() => feed.load(false)}>重试</button>
        </div>
      )}
      <ImageGrid items={feed.items} likedSet={likedSet} onOpen={onOpen} />
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
      {feed.loadingMore && <div className="hint">加载中...</div>}
      {!feed.loading && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}
    </>
  );
}
```

### 6.4 LikedPanel.jsx（从 GalleryPage.jsx 提取）

代码结构与当前 `GalleryPage.jsx` 完全一致，仅做以下调整：

1. 去掉独立的 `page` wrapper（MePage 已提供）
2. `CACHE_KEY` 改为 `'me_liked'`
3. 导出名为 `LikedPanel`，接收 `refreshToken` prop（用于外部刷新触发）

### 6.5 BookmarksPanel.jsx（从 BookmarksPage.jsx 提取）

代码结构与当前 `BookmarksPage.jsx` 完全一致，仅做以下调整：

1. 去掉独立的 `page` wrapper
2. `CACHE_KEY` 改为 `'me_bookmarks'`
3. 导出名为 `BookmarksPanel`

---

## 7. App.jsx 变更

```diff
  const TABS = [
    { key: 'discover',  label: '推荐' },
    { key: 'ranking',   label: '排行' },
-   { key: 'bookmarks', label: '收藏' },
    { key: 'search',    label: '搜索' },
-   { key: 'gallery',   label: '喜欢' },
+   { key: 'me',        label: '我' },
  ];
```

```diff
- import BookmarksPage from './pages/BookmarksPage.jsx';
- import SearchPage from './pages/SearchPage.jsx';
- import GalleryPage from './pages/GalleryPage.jsx';
+ import SearchPage from './pages/SearchPage.jsx';
+ import MePage from './pages/MePage.jsx';
```

```diff
- <div style={{ display: activeTab === 'bookmarks' ? undefined : 'none' }}>
-   {visitedTabs.has('bookmarks') && (
-     <ErrorBoundary key="bookmarks">
-       <BookmarksPage ... />
-     </ErrorBoundary>
-   )}
- </div>
  <div style={{ display: activeTab === 'search' ? undefined : 'none' }}>
    ...
  </div>
- <div style={{ display: activeTab === 'gallery' ? undefined : 'none' }}>
-   {visitedTabs.has('gallery') && (
-     <ErrorBoundary key="gallery">
-       <GalleryPage ... />
-     </ErrorBoundary>
-   )}
- </div>
+ <div style={{ display: activeTab === 'me' ? undefined : 'none' }}>
+   {visitedTabs.has('me') && (
+     <ErrorBoundary key="me">
+       <MePage
+         onOpen={openDetail}
+         onOpenSettings={openSettings}
+         registerRefresh={registerRefresh}
+         refreshToken={tabTokens.me || 0}
+       />
+     </ErrorBoundary>
+   )}
+ </div>
```

---

## 8. CSS 设计

### 8.1 SubTabBar 样式（追加到 `src/styles/me.css`）

```css
/* ══════════════════════════════════════════════
   "我"页面 · 子标签栏 + 面板
   ══════════════════════════════════════════════ */

.me-page {
  padding: 0 0 16px;
}

/* ── 子标签栏 ── */
.sub-tab-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: stretch;
  padding: 10px 12px 0;
  gap: 0;
  background: var(--bg);
}

.sub-tab-btn {
  flex: 1;
  position: relative;
  padding: 10px 0;
  font-size: 15px;
  font-weight: 500;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  text-align: center;
  transition: color 0.25s ease;
  -webkit-tap-highlight-color: transparent;
}

.sub-tab-btn.active {
  color: var(--text-primary);
  font-weight: 600;
}

/* ── 下划线指示器 ── */
.sub-tab-indicator {
  position: absolute;
  bottom: 0;
  height: 3px;
  border-radius: 2px;
  background: var(--accent);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* ── 面板容器 ── */
.me-panels {
  min-height: calc(100vh - 200px);
}
```

### 8.2 下划线指示器的精确定位

指示器使用 `position: absolute` 放在 `.sub-tab-bar` 内，通过 JS 测量当前 active 按钮的 `getBoundingClientRect()` 来计算 `transform: translateX()` 的值。过渡使用 `cubic-bezier(0.4, 0, 0.2, 1)` 达到 Material Design 风格的滑动效果。

---

## 9. 交互细节

| 场景 | 行为 |
|------|------|
| 进入"我"页面 | 默认显示"喜欢"子 Tab（离线可用） |
| 点击子 Tab | 切换面板，下划线滑动到新位置 |
| 左右滑动 | **不做**手势切换（与图片 grid 滚动冲突），仅点击切换 |
| 子 Tab 首次访问 | 懒加载（`visitedSubs` set 控制），切过去才发请求 |
| 子面板滚动 | 各自独立保留（`display: none` 不卸载 DOM） |
| 未登录 + 点击"关注"/"订阅" | 显示 NeedCookieNotice，引导设置 Cookie |
| 下拉刷新 | 刷新当前活跃的子面板 |
| 从详情页返回 | 回到"我"页面时，子 Tab 状态不变 |

---

## 10. 注意事项

1. **`fetchFollowing` 返回作品不是用户列表：** Pixiv 的 `/ajax/follow_latest/illust` 返回的是关注画师的最新插画。如果要"关注的用户列表"（头像+名字），需要新 API，本次不做
2. **`useTabFeed` 的 `registerRefresh`：** MePage 内部只有一个活跃子面板需要注册刷新回调。可以在 `switchSubTab` 时动态切换注册，或者让 MePage 统一管理三个子面板的刷新触发
3. **缓存键命名空间：** 三个 Panel 使用独立的 `cacheKey`（`me_following`、`me_liked`、`me_bookmarks`），避免 Tab 缓存冲突
4. **`pixiv:liked-changed` 事件：** LikedPanel 需要监听此事件以在外部点赞/取消后刷新列表（同原 GalleryPage）
5. **空状态文案：**
   - 关注为空：`"还没有关注任何画师 — 在排行页发现喜欢的画师吧"`
   - 喜欢为空：`"还没有喜欢的作品 — 在详情页点击爱心即可收藏"`
   - 订阅为空：`"收藏夹为空"`（Pixiv API 返回）
6. **视觉一致性：** SubTabBar 的按钮字体大小（15px）略小于主 TabBar（16px），以示层级区分

---

## 11. 迁移步骤

| 步骤 | 内容 | 预计工作量 |
|------|------|-----------|
| 1 | 新建 `src/components/SubTabBar.jsx` | 30 min |
| 2 | 新建 `src/styles/me.css` | 20 min |
| 3 | 新建 `src/components/panels/FollowingPanel.jsx` | 20 min |
| 4 | 新建 `src/components/panels/LikedPanel.jsx`（从 GalleryPage 提取） | 15 min |
| 5 | 新建 `src/components/panels/BookmarksPanel.jsx`（从 BookmarksPage 提取） | 15 min |
| 6 | 新建 `src/pages/MePage.jsx` | 20 min |
| 7 | 修改 `src/App.jsx`（TABS + import + JSX） | 15 min |
| 8 | 修改 `src/store/useAppStore.js`（TABS 同步） | 5 min |
| 9 | 删除 `src/pages/GalleryPage.jsx` | 1 min |
| 10 | 删除 `src/pages/BookmarksPage.jsx` | 1 min |
| 11 | 真机测试 + 调样式 | 30 min |
| **合计** | | **~3 小时** |

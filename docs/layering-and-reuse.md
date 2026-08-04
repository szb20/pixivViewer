# PixivViewer 分层与复用分析

> 基于 `docs/architecture-review.md` 的补充，聚焦**分层规范**和**代码复用**。

---

## 一、当前分层概览

```
UI 层：     pages/ → components/ → 渲染
状态层：    hooks/（useTabFeed、useTouchGesture）
数据层：    api/（pixiv.js、gif.js、index.js）→ pixiv-assistant/core/pixivApi.js
存储层：    pixiv-assistant/capacitor/（storageFacade → repository → fileStore/cacheDB/networkStore）
```

依赖方向单向，无循环引用，Capacitor 适配器隔离在单独目录。以下是具体问题。

---

## 二、分层问题

### 🔴 2.1 RankingPage 绕过了 `useTabFeed`

**现状**：五个 page 中，Discover、Bookmarks、Search 已使用 `useTabFeed`，但 **RankingPage（223行）** 自己重复实现了整套 feed 骨架：

- `load()` 含 seq 防竞态、内存缓存、append 拼接、持久化缓存保存
- 缓存水合：`loadTabCache` + `cacheUsedRef` + `firstFetchDoneRef` + `hydrated`
- `IntersectionObserver` 哨兵触底
- `registerRefresh` 注册
- 完整状态机：`loading / loadingMore / error / hasMore / items`

**RankingPage 唯一特殊之处**是"多档位切换"（日榜/周榜/月榜 + R18），这属于业务参数变化，不是架构差异。`useTabFeed` 已支持 `refreshToken` 驱动重新加载，完全可以承载档位切换场景。

**影响**：`useTabFeed` 的 bug 修复或优化不会惠及 RankingPage；RankingPage 的 223 行中约 140 行是骨架代码。

**建议**：RankingPage 改用 `useTabFeed`，档位切换通过 `refreshToken` 驱动；或将模式参数传给 hook（如新增 `mode: [category, r18]` 依赖数组），让 hook 在 mode 变化时自动 reload。

---

### 🔴 2.2 App.jsx 是 God Component

212 行的 `App.jsx` 承担了 5 个职责，全部耦合在一个组件函数里：

| 职责 | 代码行 | 复杂度 | 建议抽取 |
|------|--------|--------|---------|
| Tab 切换 + scroll 位置记忆 | 84-98 | 中 | `useTabNavigation` |
| refreshFns 注册表 + 分派 | 41-48 | 低 | 并入 `PullToRefresh` Context |
| 平台 backButton 适配 | 108-127 | 中 | `usePlatformBackButton` |
| overlay 栈管理（detail / authorWorks） | 72-76, 55-69 | 高 | `useOverlayStack` |
| JSX 渲染（Tab 挂载 + overlay 叠加） | 129-211 | 低 | 保留在 App.jsx |

**影响**：任何一个 overlay 或 tab 行为的改动都需要触碰 App.jsx；无法单独测试 tab 导航逻辑。

**建议**：抽取三个 hook，App.jsx 只做顶层组合。

---

### 🟡 2.3 传输层耦合了 Capacitor 平台判断

`src/api/pixiv.js` 中 `devFetch` / `prodFetch` 的差异（Vite 代理 vs CapacitorHttp）是**传输层**关注点，但和 API factory 组装写在同一文件里。

更纯粹的分层：

```
src/api/
  transport.js    ← devFetch / prodFetch（纯传输，不知道 Pixiv）
  pixiv.js        ← 只调 createPixivApi({ fetch: transport })
```

**影响**：如果想为测试环境提供一个 mock transport，或增加一个新的传输通道（如 HTTP/2），需要改 `pixiv.js`。

---

## 三、复用问题

### 🔴 3.1 GalleryPage 未使用 `useTabFeed`

GalleryPage（103行）数据源是本地 IndexedDB（`storageFacade.listLiked`），与 Pixiv API 分页模式不同（offset-based，无缓存水合可复用）。但**骨架依旧重复**：

- `load()` + `offsetRef`
- `registerRefresh`
- `IntersectionObserver` 哨兵
- `pixiv:liked-changed` 事件监听刷新

**建议**：不强行套 `useTabFeed`，但可抽取一个更基础的 `useInfiniteScroll` hook（只管触底加载 + 刷新注册 + 状态机），`useTabFeed` 和 GalleryPage 都基于它。

---

### 🔴 3.2 Error + retry / loading / empty 模板在 4 个页面中重复

SearchPage、DiscoverPage、BookmarksPage、RankingPage 都有几乎一样的样板：

```jsx
{error && (
  <div className="error-box">
    {error}
    <button className="error-retry" onClick={() => load(false)}>重试</button>
  </div>
)}

{loading && items.length === 0 && <div className="hint">加载中...</div>}
{loadingMore && <div className="hint">加载中...</div>}
{!loading && hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}
{!loading && !hasMore && items.length > 0 && <div className="hint">没有更多了</div>}
```

**建议**：抽取 `<FeedFooter>` 组件，接收 `{ loading, loadingMore, hasMore, error, sentinelRef, onRetry }`，一行替换 5 行样板。

---

### 🟡 3.3 NeedCookieNotice 检测逻辑散布

DiscoverPage 和 BookmarksPage 各自做了 cookie 过期判断：

```jsx
const needCookie = !!feed.error && /cookie|no_cookie|需要.*Cookie/i.test(feed.error);
```

**建议**：`pixivApi` 的 `classifyError` 已经能识别 403 → cookie 过期，在 `useTabFeed` 层增加 `errorType: 'cookie' | 'network' | 'empty'` 返回值，页面只需 `feed.errorType === 'cookie'` 即可。

---

### 🟡 3.4 DetailView 导航栈 vs AuthorWorksPage —— 可统一模式

`DetailView` 内部维护了 `stackRef`（详情内点相关推荐 → 压栈/弹栈）。`AuthorWorksPage` 是叠加在 detail 上的全屏页，返回时弹回 detail。两者都是"全屏叠加层 + 返回导航"模式，但没有任何共享代码。

**建议**：抽取 `useOverlayStack` hook —— 管理 `push/pop/current/close` + `registerBackHandler`，DetailView 和 AuthorWorksPage 共用。

---

### 🟢 3.5 ImageGrid 已很好地复用了

`ImageGrid` 被 Discover、Ranking、Bookmarks、Search 四个页面共用，`likedSet` 通过 Context 注入，`onOpen` 通过 prop 回调。这是项目中复用做得最好的例子——模式值得推广。

---

## 四、层次结构评估

### 做得好的

| 层次 | 评价 |
|------|------|
| **存储层** | `storageFacade → repository → fileStore/cacheDB/networkStore`，依赖方向单向，Saga 补偿完整 |
| **API 层** | `pixiv-assistant/core/pixivApi.js` 作为 API factory 独立于传输，设计合理 |
| **FrameAnimPlayer** | UgoiraPlayer / GifPlayer 已收敛为薄包装，差异通过 props 参数化，是理想的复用模式 |
| **useTabFeed** | 将 Discover/Bookmarks/Search 的公共骨架收进 hook，设计良好 |
| **ImageGrid** | 4 个页面共用，props 简洁，关注点分离 |

### 需要改进的

| 问题 | 严重程度 | 根源 |
|------|---------|------|
| RankingPage 自行实现 feed 骨架 | 高 | useTabFeed 已存在但未被采用 |
| App.jsx 职责过多 | 高 | 没有拆分 hook 的意识 |
| 页面样板代码重复（error/loading/empty） | 中 | 缺少 `<FeedFooter>` 组件 |
| NeedCookieNotice 检测散布 | 低 | useTabFeed 不返回 errorType |
| 传输层耦合 | 低 | pixiv.js 同时做了 transport 和 factory |
| overlay 导航栈模式不一致 | 低 | DetailView/AuthorWorksPage 各自实现 |

---

## 五、建议优先级

| 优先级 | 项目 | 类型 | 工作量 |
|--------|------|------|--------|
| **P1** | RankingPage 改用 useTabFeed | 分层修正 | 1h |
| **P1** | 抽取 `<FeedFooter>` 消除样板 | 复用 | 30min |
| **P2** | App.jsx 拆分 hook | 分层修正 | 2h |
| **P2** | 抽取基础 `useInfiniteScroll` hook | 复用 | 1h |
| **P3** | useTabFeed 增加 `errorType` | 复用 | 20min |
| **P3** | 拆分 `transport.js` | 分层优化 | 15min |
| **P3** | 抽取 `useOverlayStack` | 复用 | 1h |

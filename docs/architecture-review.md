# PixivViewer 代码架构审查报告

> 审查日期：2026-08-04 | 基于 commit `2d4a14e`

---

## 一、总体评估

**项目规模**：~59 个源文件，React 19 + Vite 8 + Capacitor 8，纯 JS/JSX（JSDoc 类型标注）。

**架构评价**：整体架构分层清晰，`api → core → capacitor → component` 层次分明，未引入重量级框架。作为个人项目，代码质量在同类中属于中上水平。

---

## 二、风险点

### 🔴 高风险

#### 2.1 UgoiraPlayer 与 GifPlayer 严重重复（~350 行）

**文件**：`src/components/UgoiraPlayer.jsx` (409行) vs `src/components/GifPlayer.jsx` (476行)

两个组件约 70% 代码重复——downloadCache、帧缓存逻辑、rAF 动画循环、帧预加载、togglePlay、cleanup 完全一致。唯一差异是 GifPlayer 多了一个 90s stall timeout 看门狗。

**风险**：改一处漏另一处导致行为不一致；维护成本翻倍。

**建议**：UgoiraPlayer 的注释标明它已是"legacy wrapper"，应确认是否可彻底移除；若两者共存，抽取共享的 `useGifPlayer` hook（约 250 行核心逻辑）。

#### 2.2 无 React Error Boundary

**文件**：`src/main.jsx`

整个应用没有任何 `ErrorBoundary` 组件。`window.onerror` / `unhandledrejection` 仅做日志记录，不做降级 UI。任何组件渲染异常会导致**白屏崩溃**。

**建议**：在 `App.jsx` 外层包裹一个 Error Boundary，提供"出错了，点击重试"的降级 UI。这是 React 官方推荐的最低防御。

#### 2.3 Cookie 过期无自动感知

**文件**：`src/pixiv-assistant/core/pixivApi.js`

`classifyError()` 虽然将 403 映射为"Cookie 过期"，但仅在用户主动触发 API 调用时感知。没有 token 刷新机制，Cookie 过期后所有需要认证的功能静默失败。

**建议**：在 `pixivApi.js` 的 `apiFetch` 中检测 403 → 广播 `pixiv:cookie-expired` 事件 → App.jsx 弹出设置面板提醒用户更新 Cookie。

---

### 🟡 中风险

#### 2.4 分页逻辑在页面组件中重复 5 次

**文件**：`RankingPage.jsx`、`GalleryPage.jsx`、`DiscoverPage.jsx`、`BookmarksPage.jsx`、`SearchPage.jsx`

虽然 `useTabFeed` hook 已抽取了公共部分，但 RankingPage 和 GalleryPage 仍各自实现了 `IntersectionObserver` sentinel + `loadMore` + `hasMore` 逻辑。Display name `"Ranking"` 在 scroll position 恢复和多处引用中以 hardcoded 字符串重复。

**建议**：RankingPage 和 GalleryPage 统一使用 `useTabFeed`，或将其泛化为接受 `cacheKey` + `fetchPage` 的更通用 hook。

#### 2.5 `document.querySelector('.app-content')` 直接 DOM 操作 7 处

**文件**：`App.jsx:76,83,88,98`、`PullToRefresh.jsx:44`、`RankingPage.jsx:158`、`DetailView.jsx:29`

通过字符串选择器读写 `scrollTop`，脆弱且不可类型检查。CSS 类名改名会静默失败。

**建议**：在 `App.jsx` 中创建 `appContentRef`（通过 `useRef` 绑定到最外层容器），通过 Context 向下传递，或提供一个 `useAppContentRef()` hook。

#### 2.6 `LightboxActions.jsx` 长按定时器未清理

**文件**：`src/components/LightboxActions.jsx:121`

`longPressTimerRef` 在 pointerDown 启动，在 pointerUp/Leave/Cancel 取消。但如果组件在 pointerDown 后立即 unmount（例如 lightbox 关闭），定时器不会被清除，会 fire 在已卸载的组件上。

**建议**：添加 `useEffect` cleanup：`return () => clearTimeout(longPressTimerRef.current)`。

#### 2.7 硬编码 URL 散布 10+ 处

**文件**：`api/pixiv.js`、`core/pixivApi.js`、`gif.js`、`networkStore.js`、`ImageDetailView.jsx`

`'https://www.pixiv.net'` 在多个文件中以字符串硬编码，而 `constants.js` 已定义 `PIXIV_BASE`。不一致：有的地方用常量，有的用字面量。

**建议**：全局 grep 替换所有 `'https://www.pixiv.net'` 为 `PIXIV_BASE`；同理用 `PIXIV_RE` 替换 `'https://pixiv.re'`。

---

### 🟢 低风险

#### 2.8 自定义事件名未提取为常量

`'pixiv:liked-changed'`（3 处）、`'pixiv:toast'`（2 处）、`'pixiv_viewer_settings'` 散布在多个文件中。字符串拼写错误不会在编译时发现。

**建议**：在 `constants.js` 添加 `EVENTS` 对象统一管理。

#### 2.9 `jszip` 作为静态导入

`gif.js:8 import JSZip from 'jszip'`——JSZip ~100KB gzipped，仅用于 `extractZipFrames` 的 dev fallback 路径。而 `gifenc` 已使用动态 `await import('gifenc')`。

**建议**：将 JSZip 也改为动态导入，只在 dev fallback 路径触发时再加载。

#### 2.10 `inflight` Map 可能保留已拒绝的 Promise

`gif.js:25` 的 `inflight` Map 用于请求去重。`finally` 块在 `streamUgoira` 末尾清理。如果请求在 `finally` 到达前被外部 AbortController 取消，`inflight` 中可能残留孤儿条目。

**建议**：在 `AbortController.signal` 的 `abort` 事件中主动删除 `inflight.delete(id)`。

---

## 三、可优化点

### ⭐ 架构层面

#### 3.1 App.jsx 承担过多职责（God Component）

264 行的 `App.jsx` 管理：tab 路由、scroll 位置、pixivCache 状态、detail overlay、authorWorks overlay、search seed、refresh token、back handler 注册、缓存元数据初始化。

**建议**：
- 抽取 `useTabNavigation` hook：管理 tab/visitedTabs/scrollPositions/tabTokens
- 抽取 `usePixivCache` hook：管理 pixivCache/likedSet/savedSet + `pixiv:liked-changed` 监听
- App.jsx 只负责顶层组合

#### 3.2 MediaLightbox 渲染 5 种不同类型

386 行的 `MediaLightbox.jsx` 在一个 `renderVideoContent` 函数中处理 image、gif、douyin、iwara、bilibili、video 六种媒体类型。

**建议**：抽取策略模式——每种媒体类型一个独立的渲染组件（`ImageSlide`、`GifSlide`、`VideoSlide`），MediaLightbox 只负责 slide 导航和布局。

#### 3.3 useTouchGesture hook 过长（743 行）

743 行的单文件包含了 zoom、swipe、pinch、inertia、spring physics、键盘导航、UI hide/show。全部耦合在一个 hook 中，难以单独测试。

**建议**：拆分为 `usePinchZoom`、`useSwipeNav`、`useInertiaTrack`、`useKeyboardNav` 四个独立 hook，在 `useTouchGesture` 中组合。

#### 3.4 状态管理缺乏单一数据源

`App.jsx` 的 `pixivCache` + `likedSet`/`savedSet`、IndexedDB 的 `teyvat_pixiv_cache`、各组件内部的 `useState` 缓存。同一艺术品的 liked 状态可能存在于三个地方。

**建议**：不需要引入 Redux，但可以考虑用一个 Context + useReducer 集中管理 liked/cached/saved 状态，避免 prop drilling 和不一致。

#### 3.5 无路由库，手动管理导航栈

当前用手动 history stack (`stackRef`)、`display: none` 切换 tab、`visitedTabs` Set 追踪。虽然避免了依赖，但随着功能增长，导航逻辑散布在多个组件中（`DetailView`、`App.jsx`、`AuthorWorksPage`）。

**建议**：维持不引入 React Router 是合理的（保持轻量），但可以将导航栈逻辑统一到 `useNavigationStack` hook + Context 中。

---

### ⚡ 性能层面

#### 3.6 所有 5 个 Tab 始终挂载

`App.jsx` 用 `display: none` 隐藏非活跃 Tab。这意味着 5 个页面的组件树 + IntersectionObserver + 事件监听器全部存活。对于移动端 WebView，内存和 CPU 有隐形成本。

**建议**：改为懒卸载策略——离开 Tab 超过 N 秒后卸载，仅保留 scroll 位置和缓存数据；切换回来时从 IndexedDB 恢复。或至少对非活跃 Tab 的 `IntersectionObserver` 做 `disconnect()`。

#### 3.7 CSS 文件过大

`lightbox.css` (386行) + `detail.css` (345行) 为全局样式，未做 CSS Modules 或 scoping。

**建议**：使用 Vite 内置的 CSS Modules（`.module.css`），避免全局样式污染。

#### 3.8 Vite 模板残留

`src/assets/hero.png`、`react.svg`、`vite.svg` 是 Vite 模板的占位资源，未在应用中使用，可以删除。

---

### 🔧 工程化层面

#### 3.9 无单元测试

项目中没有任何测试文件（`*.test.*`、`*.spec.*`、`__tests__/` 全部为空）。

**建议**：至少为核心逻辑添加测试——`utils.js` 中的 URL 构建函数、`pixivApi.js` 中的 `classifyError`、`gif.js` 中的帧处理逻辑。

#### 3.10 开发体验：可添加 lint-staged + pre-commit hook

当前仅有 `oxlint` 作为 lint 工具，但无自动运行的机制。

**建议**：添加 `lint-staged` + `husky` pre-commit hook，在提交前自动运行 `oxlint`。

#### 3.11 Release 构建未开启代码混淆

`android/app/build.gradle` 中 `release` 的 `minifyEnabled false`——R8 混淆和资源压缩均未开启。

**建议**：开启 `minifyEnabled true` + `shrinkResources true`，APK 可缩减 30-50%。

---

## 四、架构优点（值得保留）

| 优点 | 说明 |
|------|------|
| **分层清晰** | transport → API factory → storage service → UI facade，依赖方向单向 |
| **Saga 补偿模式** | `TransitionEngine` 对文件+元数据操作有完整的回滚/补偿逻辑 |
| **流式 Ugoira 解码** | `fflate` 流式解压避免完整 ZIP 进内存，适合移动端 |
| **LRU 缓存策略** | 6 个不同层级的 LRU 缓存（内存、磁盘、IndexedDB、HTTP），逐级降级 |
| **无 console.log 泄漏** | 统一 logger，prod 环境自动过滤 debug/info |
| **useEffect 清理规范** | 所有 addEventListener/IntersectionObserver/setTimeout/rAF 均有 cleanup |
| **自适应大图质量** | `quality.js` 根据设备像素比和设置自动选择 mini/thumb/original |
| **自定义 touch 引擎** | 绕过 React 渲染管线实现 60fps 手势，pinch/ swipe/inertia 完备 |
| **IndexedDB schema 迁移** | `cacheDB.js` 有 v1→v10 的完整 migration 链 |

---

## 五、优先级排序

| 优先级 | 项目 | 类型 | 预估工作量 |
|--------|------|------|-----------|
| **P0** | 添加 Error Boundary | 风险 | 30min |
| **P0** | 统一 UgoiraPlayer / GifPlayer | 风险+优化 | 2h |
| **P1** | 统一硬编码 URL 为常量 | 风险 | 30min |
| **P1** | LightboxActions unmount cleanup | 风险 | 10min |
| **P1** | 开启 R8 minifyEnabled | APK 体积 | 5min |
| **P2** | App.jsx 职责拆分 | 架构优化 | 3h |
| **P2** | 分页逻辑统一使用 useTabFeed | 优化 | 2h |
| **P2** | document.querySelector 改 ref | 优化 | 1h |
| **P3** | useTouchGesture 拆分 | 优化 | 4h |
| **P3** | jszip 改动态导入 | 优化 | 15min |
| **P3** | 删除 Vite 模板残留资源 | 清理 | 5min |
| **P3** | 添加核心逻辑单元测试 | 工程化 | 4h |

---

## 六、总结

PixivViewer 作为个人项目，架构设计上有不少亮点——流式 GIF 解码、多层缓存体系、Saga 补偿、自研手势引擎都体现了不错的工程素养。主要风险集中在**缺少 Error Boundary** 和 **UgoiraPlayer/GifPlayer 严重重复**两个点上，前者会导致生产崩溃无降级，后者已形成维护负担。其余是可逐步重构的优化项。

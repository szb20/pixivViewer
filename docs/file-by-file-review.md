# pixivViewer 逐文件审查报告

> 日期：2026-08-04 | 总文件数：66 个源文件 + 3 个 assets | 总代码量：~11,500 行

---

## 目录

1. [入口与全局 (1-2)](#1-入口与全局)
2. [API 层 (3-5)](#2-api-层)
3. [状态管理 (6-9)](#3-状态管理)
4. [Hooks (10-13)](#4-hooks)
5. [pixiv-assistant 核心层 (14-18)](#5-pixiv-assistant-核心层)
6. [pixiv-assistant 平台适配层 (19-31)](#6-pixiv-assistant-平台适配层)
7. [工具函数 (32-37)](#7-工具函数)
8. [页面组件 (38-42)](#8-页面组件)
9. [UI 组件 (43-50)](#9-ui-组件)
10. [辅助组件与 CSS (51-66)](#10-辅助组件与-css)

---

每文件均按以下格式报告：

> | 行数·角色 | 作用 | 依赖关系 | 放置·问题 |

---

## 1. 入口与全局

### 1. `src/main.jsx` — 29 行 — **入口**

**作用：** 挂载 React 根节点，设置 Capacitor StatusBar 样式，注册全局未捕获异常/rejection 日志。

**依赖关系：**
- 导入：`App.jsx`、`PixivCacheProvider`、`@capacitor/status-bar`、`logger`、`index.css`
- 被谁用：`index.html`（唯一入口）

**放置：** ✅ 合适。`src/` 根目录是标准 React 入口位置。

**问题：**
- `StatusBar.setStyle()` 和 `setOverlaysWebView()` 未 await，失败被静默忽略——可接受
- 全局异常仅 log 无恢复或上报机制
- `PixivCacheProvider` 是唯一的缓存 context 提供者，但 `usePixivCacheStore.js`（Zustand store）重复了同样逻辑（详见 #8）

---

### 2. `src/App.jsx` — 168 行 — **路由/布局根节点**

**作用：** 管理 5 个 Tab 的显隐（display:none 保留滚动位置）、详情/设置/作者作品全局面板、Capacitor 返回键监听。

**依赖关系：**
- 导入：9+ 页面/组件模块、`useAppStore`、`storageFacade`、`backHandler`、`@capacitor/app`（动态 import）
- 被谁用：`main.jsx`

**放置：** ✅ 合适。

**问题：**
- `window.__pixivViewer` 全局污染（第 21 行）——应放在 `main.jsx` 初始化
- `TABS` 常量与 `useAppStore.js` 重复定义
- `style={{ display: ... }}` 重复 5 次，可抽取 `<TabContent>` 组件
- `visitedTabs` Set 机制意味着首次访问后所有 Tab 常驻内存——是主动设计但未注释说明

---

## 2. API 层

### 3. `src/api/index.js` — 29 行 — **API 桶文件**

**作用：** 统一保存入口 `saveItem`：根据作品类型自动选择 GIF 编码保存或静态图下载保存。

**依赖关系：**
- 导入：`gif.js`（fetchUgoiraFrames, saveGifToAlbum）、`storageFacade`
- 被谁用：**⚠️ 无人引用**（grep 无命中）

**问题：**
- **疑似死代码**。文件注释说"历史兼容层"，`saveItem` 未被任何组件导入。`ImageDetailView.jsx` 直接调用 `saveItem` 但来自不同的路径。确认后删除。

---

### 4. `src/api/pixiv.js` — 79 行 — **HTTP 传输适配器**

**作用：** 创建平台自适应的 Pixiv API 实例：Dev 走 Vite 代理（绕过浏览器 CORS），Prod 走 CapacitorHttp（原生 HTTP 栈），有 fetch 降级。

**依赖关系：**
- 导入：`@capacitor/core`、`pixiv-assistant/core/pixivApi.js`（createPixivApi）、`getSettings`
- 被谁用：6 个文件（gif.js、SearchPage、AuthorWorksPage、RankingPage、DiscoverPage、BookmarksPage）

**放置：** ✅ 合适。

**问题：**
- `FORBIDDEN` Set 阻止 dev 端设置 `Cookie`/`Referer` 头注释不够清晰（dev 浏览器禁止，prod 需要）
- `x-pixiv-cookie` 自定义头的 Vite 代理约定未文档化

---

### 5. `src/api/gif.js` — 718 行 — **Ugoira 动图管线**

**作用：** 完整的 Ugoira → GIF 管道：获取元数据 → 流式下载 ZIP（fflate）/缓冲降级（JSZip）→ 磁盘帧缓存（LRU 双限制）→ gifenc 编码 → 保存到系统相册。

**依赖关系：**
- 导入：`jszip`、`fflate`、`@capacitor/core`、`gifenc`、`pixiv.js`、`storageFacade`、`gallery.js`、`metaBackup.js`、`downloadMonitor.js`、`logger`
- 被谁用：`FrameAnimPlayer.jsx`（fetchUgoiraFrames）、`api/index.js`（saveGifToAlbum）

**放置：** ✅ 合适。但 718 行过大，建议拆分。

**问题：**
- **职责过多**：网络下载 + 磁盘缓存 + GIF 编码 + 帧管理混在一个文件
- 模块级可变状态 `cache`(Map) 和 `inflight`(Map)——在 SPA 中可接受，但测试/SSR 不友好
- `getPixivCookie` 与 `pixiv.js` 中的 `getCookie` 功能重复
- `saveZipToDisk` 用 `concatBytes` 累积全部 chunk 后再 `new Uint8Array`——对接近 40MB 的 ZIP 存在内存峰值

---

## 3. 状态管理

### 6. `src/store/useAppStore.js` — 125 行 — **全局应用状态 (Zustand)**

**作用：** Tab 切换（含滚动位置记忆）、刷新注册/触发、详情页/作者/搜索导航、设置弹窗状态。

**依赖关系：**
- 导入：`zustand`
- 被谁用：`App.jsx`（唯一消费者）

**放置：** ✅ 合适。

**问题：**
- `TABS` 常量与 `App.jsx` 重复定义
- `visitedTabs` 用 `Set` 存在 Zustand 中——序列化/DevTools 可能有问题（当前无此需求）
- `saveScrollPosition` action 似乎无外部调用者（仅内部 setActiveTab/openDetail 使用）
- **严重：** `setActiveTab`、`openDetail`、`closeDetail` 中直接 `document.querySelector('.app-content')` —— Store 不应直接 DOM 查询

---

### 7. `src/store/usePixivCacheStore.js` — 73 行 — **Pixiv 缓存状态 (Zustand)**

**作用：** 启动时扫描 `storageFacade.getAll()` 构建 `pixivCache` + derived `likedSet`，提供 `updateEntry`/`deleteEntry`/`isLiked` 操作。

**依赖关系：**
- 导入：`zustand`、`storageFacade`、`getCompositeKey`、`logger`
- 被谁用：**⚠️ 无人引用**

**问题：**
- **与 `PixivCacheProvider.jsx` 功能完全重复**——两者独立维护同样数据。React Context 版本被使用，Zustand 版本未被引用。应删除以减少双源风险。

---

### 8. `src/context/pixivCacheContext.js` — 25 行 — **Context 定义**

**作用：** 定义两个 React Context（PixivCacheContext 读写层 + LikedSetContext 只读层）及 custom hooks。

**依赖关系：**
- 导入：`react`
- 被谁用：`PixivCacheProvider.jsx`、`LightboxActions.jsx`、SearchPage、RankingPage、DiscoverPage、BookmarksPage

**放置：** ✅ 合适。

**问题：** 无显著问题。拆分读写/只读两个 Context 是正确的优化手段（减少不必要重渲染）。

---

### 9. `src/context/PixivCacheProvider.jsx` — 82 行 — **缓存 Provider**

**作用：** 应用启动时从 IndexedDB 扫描所有缓存元数据，构建 `pixivCache` 和 derived `likedSet`，通过 context 下发。

**依赖关系：**
- 导入：`storageFacade`、`metaBackup.js`（restoreMetaBackupIfNeeded）、`pixivCacheContext.js`、`logger`
- 被谁用：`main.jsx`（App 根）

**放置：** ✅ 合适。

**问题：**
- `useStableFilteredSet` 中 `[...prev].every` 在数千条记录时性能欠佳
- 与 `usePixivCacheStore.js` 功能重复——应保留此文件，删除 Zustand 版本

---

## 4. Hooks

### 10. `src/hooks/useTabFeed.js` — 158 行 — **Tab 公共骨架 Hook**

**作用：** 统一封装 Tab 页的分页加载：IndexedDB 缓存水合、首拉 gating、IntersectionObserver 哨兵无限滚动、`registerRefresh` 刷新注册、完整状态机（loading/loadingMore/error/items/hasMore）。

**依赖关系：**
- 导入：`loadTabCache`、`saveTabCache`、`useStableCallback`、`logger`
- 被谁用：DiscoverPage、BookmarksPage、SearchPage、GalleryPage（**RankingPage 未用**——手动重复了同样逻辑）

**放置：** ✅ 合适。核心抽象，设计良好。

**问题：**
- `load` 的 `useCallback` 依赖 `fetchPageStable`——如果父组件传内联函数会频繁重建
- RankingPage 未采用此 hook，有 ~50 行重复状态机代码

---

### 11. `src/hooks/useStableCallback.js` — 7 行 — **稳定回调**

**作用：** 创建引用永远指向最新函数但自身引用不变的 wrapper，解决 `useCallback` 闭包陷阱。

**依赖关系：**
- 导入：`react`
- 被谁用：`useTabFeed.js`

**放置：** ✅ 合适。

**问题：** 无。经典模式，实现简洁正确。

---

### 12. `src/hooks/useImagePreloader.js` — 49 行 — **图片预加载**

**作用：** 利用 `requestIdleCallback` 在浏览器空闲时批量预加载图片 URL，有 LRU 淘汰（FIFO，上限 300）。

**依赖关系：**
- 导入：`react`、`logger`
- 被谁用：**⚠️ 未被任何文件引用**

**问题：**
- **疑似死代码。** `preloadImages` 和 `useImagePreloader` 均未被 import。确认后删除。
- 模块级 `preloaded` Set 跨组件生命周期保留，永不清理（仅 LRU 淘汰）

---

### 13. `src/hooks/useTouchGesture.js` — 747 行 — **手势引擎**

**作用：** 灯箱的完整触摸交互：单指滑动导航、双击缩放、Pinch-to-zoom（带 rubber-band 阻尼）、边缘滑动翻页、惯性动画、弹簧回弹、键盘导航。

**依赖关系：**
- 导入：`react`
- 被谁用：`MediaLightbox.jsx`（唯一消费者）

**放置：** ✅ 合适。但 747 行过大。

**问题：**
- **建议拆分**为 `usePinchZoom`、`useSwipeNav`、`useInertia`
- `handleTouchMove` 110 行，三个分支耦合在一个函数
- 直接 DOM 操作（`el.style.transform`）绕过 React 渲染管线——为 60fps 有意为之，注释详尽

---

## 5. pixiv-assistant 核心层

### 14. `src/pixiv-assistant/index.js` — 22 行 — **模块桶文件**

**作用：** pixiv-assistant 子系统的公共 API 面，统一 re-export 核心 + 平台层 + 存储层所有公开符号。

**依赖关系：**
- 导入：12 个子模块
- 被谁用：12 个文件（App、Provider、gif、LightboxActions、Gallery、useTabFeed、SettingsModal、Ranking、api/index、api/pixiv、quality、usePixivCacheStore）

**放置：** ✅ 合适。

**问题：** `core` 和 `capacitor` 导出有重叠（如 `PixivEntity` 两处都导出），不确定权威来源。

---

### 15. `src/pixiv-assistant/core/constants.js` — 36 行 — **常量**

**作用：** Pixiv 基础 URL、缓存 TTL、排行榜 mode/category 枚举、R18 分类集合。

**依赖关系：**
- 导入：无
- 被谁用：`fileStore.js`（CACHE_DIR）、`pixivApi.js`（TTL map）

**放置：** ✅ 合适。

**问题：** 
- `CACHE_DIR = 'TeyvatWhisper'` 是另一个项目（原神相关）的名字，应改为 `'pixivViewer'`
- `RANKING_MODES` 与 `RankingPage.jsx` 中的 `MODES` 重复

---

### 16. `src/pixiv-assistant/core/types.js` — 92 行 — **JSDoc 类型定义**

**作用：** Pixiv 数据模型 JSDoc typedef（PixivIllust、PixivIllustDetail、PixivRankingItem、PixivGifMeta、PixivCacheMeta）。

**依赖关系：**
- 导入：无（纯注释，仅 `export {}` 标记为模块）
- 被谁用：**⚠️ 无人直接 import**

**放置：** ✅ 合适。

**问题：**
- 所有 typedef 是纯 JSDoc 注释，无运行时值。如果 IDE 能利用则保留，否则是纯文档
- 缺少 `PixivEntity` 类型定义

---

### 17. `src/pixiv-assistant/core/utils.js` — 228 行 — **核心工具函数**

**作用：** Pixiv 模块纯函数工具集：图片 URL 生成/代理（`pixivReUrl`、`pixivPageUrl`、`proxyThumb`）、文件名安全化（`safeFileName`）、缓存 key 生成（`getCompositeKey`、`makeId`）、缓存文件名解析（`parseCacheFileName`）。

**依赖关系：**
- 导入：`constants.js`（PIXIV_RE）、`logger`
- 被谁用：`pixivApi.js`、`fileStore.js`、`storageService.js`、`entity.js`、`repository.js`、`helpers.js`、GalleryPage、ImageDetailView

**放置：** ✅ 合适。纯函数工具集，无副作用。

**问题：**
- `USE_PROXY` 常量在模块顶层判断 `window` 和 `import.meta`——Node/SSR 下 `import.meta` 未定义会崩溃
- `parseCacheFileName` 87 行，兼容了 8 种历史文件名格式——累积迁移债

---

### 18. `src/pixiv-assistant/core/pixivApi.js` — 521 行 — **Pixiv API 工厂**

**作用：** 基于 transport 接口（fetch + getCookie）创建全部 Pixiv API 方法：搜索、详情、发现、排行榜、收藏（bookmarks）、关注（following）、作者作品、相似推荐。含 LRU 详情缓存和错误分类。

**依赖关系：**
- 导入：`utils.js`（URL 函数）、`logger`
- 被谁用：`api/pixiv.js`（transport 提供方），进而被所有页面组件使用

**放置：** ✅ 合适。核心抽象，通过依赖注入解耦 HTTP 实现。

**问题：**
- 521 行过大，建议按域拆分（search.js/discovery.js/ranking.js/bookmarks.js）
- `classifyError` 使用中文字符串匹配（`'网络错误'`）——不同浏览器错误消息可能不同
- `illustCache` 是模块级单例——多 transport 实例会共享同一缓存
- `fetchUserIllusts` 使用 `profile/top` 而非 `profile/all`——可能丢失早期作品

---

## 6. pixiv-assistant 平台适配层

### 19. `src/pixiv-assistant/capacitor/index.js` — 17 行 — **平台层桶文件**

**作用：** 聚合 re-export Capacitor 平台层的所有子模块（cacheDB、entity、repository、fileStore、transitionEngine、storageService、networkStore、storageFacade、tabCache、metaBackup）。

**依赖关系：**
- 导入：10 个子模块
- 被谁用：`pixiv-assistant/index.js`

**放置：** ✅ 合适。

**问题：** 无。简洁标准的 barrel 模式。

---

### 20. `src/pixiv-assistant/capacitor/config.js` — 93 行 — **DI 配置**

**作用：** 依赖注入配置层：允许注入 settings 和 FS 适配器（支持测试替换/平台替换），未注入时使用 localStorage + Capacitor Filesystem 默认实现。

**依赖关系：**
- 导入：`@capacitor/filesystem`（动态 import）、`localStorage`、`import.meta.env`
- 被谁用：`fileStore.js`（getFS）、`metaBackup.js`（getSettingsSync、saveSettings）

**放置：** ✅ 合适。DI 容器使模块可测试。

**问题：**
- `getSettingsSync` 读取 `VITE_PIXIV_COOKIE` 环境变量——构建时打包，cookie 变化需重新构建
- `getSettingsSync` 无 `typeof localStorage !== 'undefined'` 守卫——SSR 会崩溃
- `_fsCache` 永久缓存 FS 对象——如果 Capacitor 插件延迟可用则无法检测

---

### 21. `src/pixiv-assistant/capacitor/entity.js` — 160 行 — **领域模型**

**作用：** Pixiv 全系统统一数据模型类 `PixivEntity`：字段定义、ID 生成工厂（`makeId`）、不可变风格更新方法（`withState`、`withFlags`）、旧 IndexedDB record 格式兼容转换（`fromRecord`/`toRecord`）。

**依赖关系：**
- 导入：`utils.js`（safeFileName、getCompositeKey）
- 被谁用：`repository.js`、`storageService.js`、`metaBackup.js`

**放置：** ✅ 合适。DDD 风格核心领域模型。

**问题：**
- `fromRecord` 中从 `cacheKey` 名推断 `type`（`_g0` 或 `ugoira_` 前缀）不够可靠
- `toRecord` 字段名沿用旧名 `cacheKey`，与新架构统一用 `id` 不一致
- 属性都是 public mutable——不可变方法（`withState`）存在但无法阻止直接赋值

---

### 22. `src/pixiv-assistant/capacitor/cacheDB.js` — 590 行 — **IndexedDB 存储**

**作用：** Pixiv 缓存元数据的 IndexedDB 抽象：DB 打开/升级（v1→v10）、元数据 CRUD、分页查询、索引查询、统计、导入导出。

**依赖关系：**
- 导入：`logger`、浏览器 `indexedDB`
- 被谁用：`repository.js`（全部操作）、`metaBackup.js`（getAllMeta、putMetaBatch）

**放置：** ✅ 合适。数据访问层唯一入口。

**问题：**
- **严重：** 底部 IIFE `cleanTitles` 每次 import 执行全表扫描清理标题——应改为版本绑定的单次迁移
- `onupgradeneeded` 150 行内联 10 版本迁移逻辑——建议重构为迁移函数表
- `getByStatePaginated` 有三级降级（索引→时间索引→全表扫描）且返回无用 `_diag` 对象
- `getCacheStats` 全表游标遍历——大数据集阻塞事务

---

### 23. `src/pixiv-assistant/capacitor/repository.js` — 194 行 — **仓储层**

**作用：** Entity ↔ IndexedDB 映射器（Repository 模式）：`find`/`save`/`delete`/`listByState`/`toggleLike`/`getStats`，含旧格式 key 兼容迁移。

**依赖关系：**
- 导入：`entity.js`、`cacheDB.js`
- 被谁用：`storageService.js`、`transitionEngine.js`

**放置：** ✅ 合适。仓储模式隔离存储实现。

**问题：**
- 每次 `find` 检查 3 种旧 key 格式——应一次性迁移后移除兼容逻辑
- `toggleLike` 无记录时创建"轻量记录"（副作用不直观）
- `changeState` 同时写 `state` 和 `saved` 双字段——过渡期技术债

---

### 24. `src/pixiv-assistant/capacitor/fileStore.js` — 256 行 — **文件存储层**

**作用：** 文件操作 + 路径规则：保存（base64→Capacitor Filesystem/系统相册）、加载（→blob URL）、复制/移动/删除、文件名生成（含安全截断）。

**依赖关系：**
- 导入：`config.js`（getFS）、`constants.js`（CACHE_DIR）、`utils.js`（safeFileName）、`gallery.js`、`logger`
- 被谁用：`storageService.js`、`transitionEngine.js`

**放置：** ✅ 合适。

**问题：**
- `save` 中 `saved` 状态只写系统相册不写私有副本——`load` 同时查两处但 `save` 不保证两处都有
- `_resolveDir` 忽略 `state` 参数始终返回同一目录
- `_base64ToBuf` 用 `fetch` 做 base64→ArrayBuffer——应用 `Uint8Array.from(atob(...), c => c.charCodeAt(0))`
- `buildFileName` 超长截断可能切在多字节字符中间

---

### 25. `src/pixiv-assistant/capacitor/transitionEngine.js` — 154 行 — **状态迁移引擎**

**作用：** 执行 cached↔saved 状态转换的 Saga 模式补偿事务：复制文件→更新元数据→清理源文件，失败时倒序回滚。

**依赖关系：**
- 导入：`logger`；`repository` 和 `fileStore` 通过构造函数注入
- 被谁用：`storageService.js`

**放置：** ✅ 合适。职责单一、边界清晰。

**问题：**
- Saga 补偿中删除源文件失败只 silent catch——元数据与文件可能不一致
- `Saga` 类是内部用且仅 16 行——过度设计，普通对象即可
- 仅处理 cached↔saved，delete 操作绕过此引擎

---

### 26. `src/pixiv-assistant/capacitor/networkStore.js` — 132 行 — **网络下载**

**作用：** 从 Pixiv 下载图片（base64）+ 获取 Ugoira 元数据。三级降级：原生流式下载→CapacitorHttp→fetch。

**依赖关系：**
- 导入：`@capacitor/core`、`nativeDownload.js`、`logger`
- 被谁用：`storageService.js`

**放置：** ✅ 合适。

**问题：**
- Dev/Prod 分支逻辑恰好反过来（Dev 走 fetch，Prod 走原生）——代码冗余
- `_downloadWithCapacitor` 中 `resp.data` 可能为 data URL 格式，切割逻辑只按逗号分
- `AbortSignal.timeout(15000)` 兼容性有限（较新浏览器才支持）

---

### 27. `src/pixiv-assistant/capacitor/storageService.js` — 372 行 — **业务编排层**

**作用：** 组合 Repository + FileStore + TransitionEngine + NetworkStore 完成端到端业务：save/unsave/delete/load/getState/toggleLike/saveFromNetwork/listLiked/getCacheStatus。

**依赖关系：**
- 导入：`entity.js`、`repository.js`、`fileStore.js`、`transitionEngine.js`、`networkStore.js`、`gallery.js`、`downloadMonitor.js`、`metaBackup.js`、`utils.js`、`logger`
- 被谁用：`storageFacade.js`

**放置：** ✅ 合适。架构中最规范的文件之一。

**问题：**
- 6 处 GIF 回退逻辑重复（`makeId(illustId, 0)`→`isGif` 判断）——应抽取 `_resolveEntity`
- `saveFromNetwork` 130 行过于庞大——应拆分为 `_downloadAndCreateEntity` + `_writeEntity`
- 进度模拟 `rampTimer` 在 `gotRealProgress` 被设为 true 后仍运行到 55%
- 构造 `PixivEntity` 时大量内联对象重复——应建立工厂函数

---

### 28. `src/pixiv-assistant/capacitor/storageFacade.js` — 150 行 — **UI 门面**

**作用：** PixivStorageService 的 UI 门面：参数空值校验、错误转换、`_saveInFlight` Map 并发去重（同一作品重复保存共享 Promise）。

**依赖关系：**
- 导入：`storageService.js`
- 被谁用：7 个文件（App、LightboxActions、ImageDetailView、PixivCacheProvider、GalleryPage、api/index、usePixivCacheStore）

**放置：** ✅ 合适。Facade 模式在最外层。

**问题：**
- `_saveInFlight` Map 无 TTL 清理——若 Promise 永不 resolve，对应 key 永久占据
- 大量方法为平凡透传（`getState`、`load`、`getCacheStatus`）——可直接暴露 service
- `delete` 不像 save 那样做并发去重

---

### 29. `src/pixiv-assistant/capacitor/tabCache.js` — 175 行 — **Tab 缓存**

**作用：** 各 Tab 页 API 返回数据的 IndexedDB 缓存（独立数据库 `teyvat_pixiv_tabs`），带 24 小时 TTL 自动过期。

**依赖关系：**
- 导入：`logger`、浏览器 `indexedDB`
- 被谁用：`useTabFeed.js`（通过 saveTabCache/loadTabCache）

**放置：** ✅ 合适（实际不依赖 Capacitor 平台，Web 也通用）。

**问题：**
- **第二个独立 IndexedDB 数据库**——与 `cacheDB.js` 的 `teyvat_pixiv_cache` 分开，双连接双迁移开销
- `getTTL` 中 `ranking:` 前缀特殊处理无实际功能差异（所有 TTL 都是 24h）
- `loadTabCache` 中过期删除是 fire-and-forget——可能 unhandled rejection

---

### 30. `src/pixiv-assistant/capacitor/gallery.js` — 109 行 — **系统相册适配**

**作用：** Android 原生 GallerySaver 插件封装：图片导出/读取/存在性检查/删除到系统相册（MediaStore API，无需存储权限）。

**依赖关系：**
- 导入：`@capacitor/core`、`logger`
- 被谁用：`fileStore.js`、`storageService.js`

**放置：** ✅ 合适。

**问题：**
- `granted !== false` 对 `undefined` 边界返回 true（过于宽松）
- `saver` 不存在时静默返回 false——文件可能无声丢失
- MIME_MAP 缺少 `.bmp`/`.svg` 映射

---

### 31. `src/pixiv-assistant/capacitor/metaBackup.js` — 202 行 — **元数据备份/恢复**

**作用：** 将 liked/saved 元数据 + Cookie 写为 JSON 文件到 Downloads 目录（通过 GallerySaver 插件），卸载重装后恢复。解决 IndexedDB 随 WebView 卸载即清空的痛点。

**依赖关系：**
- 导入：`@capacitor/core`、`cacheDB.js`、`config.js`、`entity.js`、`logger`
- 被谁用：`storageService.js`（scheduleMetaBackup）、`PixivCacheProvider.jsx`（restoreMetaBackupIfNeeded）

**放置：** ✅ 合适。数据安全层。

**问题：**
- JSON 明文存储含完整 `pixivCookie`——若设备分享则 Cookie 泄露
- 旧版 PNG 解析路径未校验数据长度
- `putMetaBatch` 恢复不在事务中——中途失败可能部分恢复

---

## 7. 工具函数

### 32. `src/utils/logger.js` — 36 行 — **日志**

**作用：** 命名空间日志：`createLogger(tag)` 创建 [tag] 前缀 logger，DEV 输出全部级别，Prod 只输出 warn/error。

**依赖关系：**
- 导入：`import.meta.env.DEV`
- 被谁用：24 个文件（几乎全项目）

**放置：** ✅ 合适。基础设施横切关注点。

**问题：**
- `import.meta.env.DEV` 是 Vite 特有，迁移到其他构建工具需改动
- `MIN_LEVEL` 在加载时确定，运行时无法动态切换（调试不友好）
- 生产环境日志无持久化/聚合

---

### 33. `src/utils/toast.js` — 10 行 — **Toast 通知**

**作用：** 通过 `window.dispatchEvent(new CustomEvent('pixiv:toast', ...))` 广播 toast，由 `ToastHost.jsx` 订阅渲染。

**依赖关系：**
- 导入：无
- 被谁用：`LightboxActions.jsx`（唯一消费者）

**放置：** ✅ 合适。

**问题：**
- `seq` 递增 ID——理论上有 Number 安全整数上限，但实际不构成问题
- 只有一个消费者，考虑内联

---

### 34. `src/utils/backHandler.js` — 20 行 — **返回键管理**

**作用：** 全局返回处理器注册表（Set），后注册先执行（LIFO），带 500ms 全局防抖。

**依赖关系：**
- 导入：无
- 被谁用：`App.jsx`、`AuthorWorksPage.jsx`、`SettingsModal.jsx`

**放置：** ✅ 合适。

**问题：**
- 500ms 全局防抖——若两个不同页面嵌套弹窗，第二次合法返回会被吞掉
- `[...handlers].reverse()` 每次创建数组副本——频繁返回事件有 GC 压力
- 无优先级系统——所有 handler 平等，仅有 LIFO 排序

---

### 35. `src/utils/downloadMonitor.js` — 85 行 — **下载监视器**

**作用：** 全局下载进度单例（框架无关），`start`/`setProgress`/`setStatus`/`finish` + `subscribe`/`getSnapshot`（useSyncExternalStore 协议），完成 8 秒后自动清除。

**依赖关系：**
- 导入：无
- 被谁用：`gif.js`、`storageService.js`、`DownloadMonitor.jsx`

**放置：** ✅ 合适。观察者模式实现干净。

**问题：**
- `finish` 中 8 秒延迟删除 job——若用户在此期间重新开始同一 key 的下载，旧 setTimeout 可能误删新 job（竞态条件）
- `getSnapshot` 返回共享可变数组引用——调用方可能意外修改内部状态

---

### 36. `src/utils/nativeDownload.js` — 42 行 — **原生下载**

**作用：** Android `StreamingDownload` Capacitor 插件封装：绕过 WebView CORS 的原生流式下载，返回 base64，含 80ms 节流进度回调。

**依赖关系：**
- 导入：`@capacitor/core`
- 被谁用：`networkStore.js`

**放置：** ✅ 合适。

**问题：**
- 无超时设置——若原生层卡死则 Promise 永久挂起
- `id = url + Date.now()`——同一 URL 并发下载会生成不同 id，进度监听不影响但缺乏幂等性
- 进度回调未 try/catch——若回调内部抛异常，后续 `handle.remove()` 不会执行

---

### 37. `src/utils/quality.js` — 17 行 — **画质工具**

**作用：** `gridThumbUrl(url, quality)` 根据画质设置生成缩略图 URL（mini=48×48, thumb=250×250）。

**依赖关系：**
- 导入：`getSettingsSync`
- 被谁用：`ImageDetailView.jsx`、`AuthorWorksPage.jsx`

**放置：** ✅ 合适。

**问题：**
- `getSettingsSync()` 作为默认参数在模块加载时求值一次——后续 settings 变化默认值不更新。不过调用方都显式传入 quality，实际不受影响
- Pixiv CDN URL 格式变化时正则替换静默失效

---

## 8. 页面组件

### 38. `src/pages/DiscoverPage.jsx` — 67 行 — **发现页**

**作用：** Pixiv 每日推荐作品流，使用 `useTabFeed` 统一管理分页+缓存+哨兵。

**依赖关系：**
- 导入：`pixivApi`、`useTabFeed`、`useLikedSet`、`ImageGrid`、`NeedCookieNotice`
- 被谁用：`App.jsx`

**放置：** ✅ 合适。`useTabFeed` 的标准用法范例。

**问题：**
- `log.warn` 误用为 debug 日志
- Cookie 缺失检测用脆弱正则（`/'cookie|no_cookie|需要.*Cookie/i`）
- `start` 用 `rawList.length` 而非 `filtered.length`——去重过多时 offset 错误导致漏数据

---

### 39. `src/pages/RankingPage.jsx` — 223 行 — **排行榜页**

**作用：** 排行榜：日/周/月/男性向/女性向/R18 多分类切换，滚动隐藏筛选栏，内存缓存+持久化缓存。

**依赖关系：**
- 导入：`pixivApi`、`saveTabCache`/`loadTabCache`、`useLikedSet`、`ImageGrid`、`logger`
- 被谁用：`App.jsx`

**放置：** ✅ 合适。

**问题：**
- **未使用 `useTabFeed`**——手动实现约 50 行重复的分页/缓存/哨兵逻辑
- `refreshToken` 行为误导：注释说"双击当前 Tab 时 +1"但实际是 toggle 筛选栏显隐
- `handleR18Toggle` 有两个冗余 early return
- `fetchSeqRef` 竞态控制好但不取消网络请求（无 AbortController）
- 223 行为五个页面中最复杂的——建议抽取 `useRanking` hook

---

### 40. `src/pages/BookmarksPage.jsx` — 57 行 — **收藏页**

**作用：** Pixiv 公开收藏夹（bookmarks），使用 `useTabFeed` 管理分页。

**依赖关系：**
- 导入：`pixivApi`、`useTabFeed`、`useLikedSet`、`ImageGrid`、`NeedCookieNotice`
- 被谁用：`App.jsx`

**放置：** ✅ 合适。

**问题：**
- API 返回字段 `works`（而非 `illusts`）与其他 API 不一致
- 未设置 `_totalPages`，多页收藏作品不会展示页码信息
- 与 `DiscoverPage` 模板代码高度重复——可抽取共享 `<FeedPage>` 布局

---

### 41. `src/pages/SearchPage.jsx` — 165 行 — **搜索页**

**作用：** Pixiv 关键词搜索，Portal 渲染底部搜索栏，搜索历史（localStorage, 最多 12 条），支持从详情页 Tag 跳转搜索。

**依赖关系：**
- 导入：`pixivApi`、`useTabFeed`、`useLikedSet`、`ImageGrid`、`SearchIcon`

**放置：** ✅ 合适。

**问题：**
- `querySelector('.app')` 硬编码 DOM 结构——若 `.app` 重命名 Portal 静默失效
- 搜索历史无容量限制和过期清理
- `searchSeed` useEffect 无防抖/去重保护——引用变化就重复搜索
- 滚动隐藏搜索栏逻辑与 RankingPage 重复

---

### 42. `src/pages/GalleryPage.jsx` — 74 行 — **本地画廊页**

**作用：** 查看本地点赞（liked）的作品，数据源为 IndexedDB（`storageFacade.listLiked`），离线可用。

**依赖关系：**
- 导入：`storageFacade`、`useTabFeed`、`pixivReUrl`
- 被谁用：`App.jsx`

**放置：** ✅ 合适。

**问题：**
- `onOpen` 硬编码 page 0 缩略图——多页作品详情页不满
- 通过 `pixiv:liked-changed` 事件驱动刷新——与其他页面的 Zustand store 方式不一致
- `loading` 始终置 `true` 在 append 场景——首次和追加都用同一个 spinner

---

## 9. UI 组件

### 43. `src/components/TabBar.jsx` — 15 行 — **底部 Tab 栏**

**作用：** 渲染带毛玻璃效果的底部导航按钮组，支持 active 状态高亮。

**依赖关系：**
- 导入：无
- 被谁用：`App.jsx`

**放置：** ✅ 合适。极简纯展示组件。

**问题：**
- 无无障碍属性（`role="tablist"`、`role="tab"`、`aria-selected`）
- 无节流/防抖——快速双击可能重复触发状态变更

---

### 44. `src/components/ImageGrid.jsx` — 60 行 — **图片网格**

**作用：** 响应式 2 列图片缩略图网格：`React.memo` 优化 + 加载失败隐藏 + 喜欢标记（爱心）+ GIF 指示 + 多页 badge。

**依赖关系：**
- 导入：`HeartIcon`
- 被谁用：DiscoverPage、RankingPage、BookmarksPage、SearchPage（**GalleryPage 未用**——有自己的网格实现）

**放置：** ✅ 合适。清洁的展示组件。

**问题：**
- `likedSet` key 固定 `${illustId}_0`——只检查 page 0，多页作品其他页状态无法正确显示
- `GridItem` memo 比较不比较 `pageCount`、`thumbnailUrl`——缩略图更新时可能不重渲染
- `illustType === 2` 是魔数——无枚举常量

---

### 45. `src/components/MediaLightbox.jsx` — 396 行 — **媒体灯箱**

**作用：** 统一图片+GIF+Ugoira+视频（抖音/iwara/B站/通用）的全屏灯箱：Portal 渲染、手势驱动幻灯片切换、视频播放控制、图片加载重试（最多 3 次）、相邻页预加载。

**依赖关系：**
- 导入：`GifPlayer`、`useTouchGesture`、`logger`
- 被谁用：`App.jsx`（灯箱入口）、`ImageDetailView.jsx`

**放置：** ✅ 合适。但 396 行过大。

**问题：**
- `renderVideoContent` 100 行 switch/case——每个视频平台应独立为工厂函数或子组件
- `VideoPlayer` 内联定义在此文件——应独立为 `VideoPlayer.jsx`
- `key={src}` 在视频组件上——若两个不同作品共享同一视频 URL 会冲突
- 图片重试 `retryMap` 不在切换作品时清理旧条目

---

### 46. `src/components/LightboxActions.jsx` — 138 行 — **灯箱操作按钮**

**作用：** `LikeButton` 组件：点击切换❤️+自动保存单页，长按喜欢+下载全部页。使用 `PixivCacheContext` + `storageFacade.toggleLike`。

**依赖关系：**
- 导入：`getCompositeKey`、`storageFacade`、`usePixivCache`、`showToast`、`HeartIcon`
- 被谁用：`MediaLightbox.jsx`（renderActions prop）、`ImageDetailView.jsx`

**放置：** ✅ 合适。但文件名暗示仅用于灯箱，实际也在详情页使用。

**问题：**
- `handleLike` 乐观更新：先设乐观状态→调 API→失败回滚。但 `notifyLikedChanged` 在中间广播，导致 GalleryPage 可能刷新到不一致数据
- `longPressTriggeredRef` 标志位——依赖 pointerup 在 click 之前触发的事件顺序，不同浏览器行为可能不同
- `typeof storageFacade.toggleLike !== 'function'` 每次点击都判断——应在初始化时缓存

---

### 47. `src/components/FrameAnimPlayer.jsx` — 548 行 — **帧动画播放器**

**作用：** Canvas 逐帧动画播放器核心：`GifPlayer` 和 `UgoiraPlayer` 的共享基类。帧加载、Canvas rAF 渲染循环、下载缓存、进度条、播放/暂停、尺寸自适应。

**依赖关系：**
- 导入：`fetchUgoiraFrames`、`logger`
- 被谁用：`GifPlayer.jsx`、`UgoiraPlayer.jsx`

**放置：** ✅ 合适。但 548 行为项目中最大单文件。

**问题：**
- **严重需要拆分**：建议 `useFrameCache` + `useFramePlayback` + `useCanvasSizing` + `FrameProgress` 组件
- 模块级 `downloadCache` Map——跨热重载保留
- 4 处 `eslint-disable` 注释——闭包问题未根本解决
- Canvas 尺寸计算 10+ 行分支逻辑（`capWidthByCanvas`/`capByMaxHeight`/`knownRatio`/`useCanvasRatio`）——应提取为纯函数并单元测试
- `playFrame` 长时间暂停后恢复——所有帧瞬间跳过而非逐帧

---

### 48. `src/components/GifPlayer.jsx` — 22 行 — **GIF 播放器**

**作用：** `FrameAnimPlayer` 的 GIF 薄包装：传入环形进度条、停滞超时 90s、防抖切换、触摸手势支持。

**依赖关系：**
- 导入：`FrameAnimPlayer`
- 被谁用：`MediaLightbox.jsx`

**放置：** ✅ 合适。干净的策略模式委托。

**问题：** 无。薄包装设计良好。

---

### 49. `src/components/UgoiraPlayer.jsx` — 22 行 — **Ugoira 播放器**

**作用：** `FrameAnimPlayer` 的 Ugoira 薄包装：线性进度条、无停滞检测、清除缓存重试、暂停提示。

**依赖关系：**
- 导入：`FrameAnimPlayer`
- 被谁用：`ImageDetailView.jsx`

**放置：** ✅ 合适。

**问题：**
- `clearCacheOnError` 为 true——弱网加载失败后清除缓存意味重试需重新下载所有帧
- `stallTimeout=0` 关闭停滞检测——若网络永久挂起无超时提示

---

### 50. `src/components/ErrorBoundary.jsx` — 76 行 — **错误边界**

**作用：** React 类组件 Error Boundary：捕获子组件渲染错误 → 记录日志 → 展示回退 UI（支持自定义 fallback 组件/元素/文本）。

**依赖关系：**
- 导入：`logger`
- 被谁用：`App.jsx`（包裹每个 Tab 和 detail）

**放置：** ✅ 合适。

**问题：**
- `errorInfo` 在 `componentDidCatch` 中仅 log 未存 state——无法在回退 UI 中展示组件栈
- `fallback` prop 和 `FallbackComponent` prop 语义重叠且容易混淆
- 内联样式硬编码色值和尺寸——应用 CSS 类替代

---

## 10. 辅助组件与 CSS

### 51. `src/components/ToastHost.jsx` — 24 行 — **Toast 宿主**

**作用：** 监听 `pixiv:toast` CustomEvent，渲染浮动提示列表，2.5 秒后自动移除。

**依赖关系：**
- 导入：无
- 被谁用：`App.jsx`

**放置：** ✅ 合适。

**问题：**
- `Date.now()` 作为 fallback ID——毫秒级并发 toast 会冲突
- 定时器未在 unmount 时清理——组件卸载后 `setToasts` 调用为 no-op 但 setTimeout 泄漏
- 固定 2500ms 不可配置
- 无最大数量限制——大量 toast 会溢出屏幕

---

### 52. `src/components/PullToRefresh.jsx` — 111 行 — **下拉刷新**

**作用：** 移动端下拉刷新：触摸下拉 → 白色光点呼吸动画 → 超过阈值触发 `onRefresh` → 弹簧回弹。

**依赖关系：**
- 导入：`react`
- 被谁用：`App.jsx`

**放置：** ✅ 合适。

**问题：**
- **严重：** `document.querySelector('.app-content')` 硬编码 DOM 结构——CSS 变化静默失效
- `onRefresh` 作为 useEffect deps——父组件传新引用则重建所有 touch 监听器（应用 `useStableCallback`）
- 仅支持 touch 事件——桌面端无下拉刷新能力（移动端优先可接受）

---

### 53. `src/components/SettingsModal.jsx` — 94 行 — **设置弹窗**

**作用：** Pixiv Cookie、代理 URL、网格/详情画质设置，`registerBackHandler` 注册 Android 返回键处理。

**依赖关系：**
- 导入：`getSettings`/`saveSettings`、`registerBackHandler`
- 被谁用：`App.jsx`

**放置：** ✅ 合适。

**问题：**
- `handleSave` 用 read-modify-write 模式——并发修改可能丢失
- `setTimeout(onClose, 900)`——组件若在 900ms 内卸载仍会调用 onClose
- 无 Cookie 格式验证（应匹配 `{digits}_{alphanumeric}`）

---

### 54. `src/components/NeedCookieNotice.jsx` — 9 行 — **Cookie 提示**

**作用：** 提示用户设置 PHPSESSID，提供"去设置"按钮触发父组件打开弹窗。

**依赖关系：**
- 导入：无
- 被谁用：`App.jsx`、DiscoverPage、BookmarksPage

**放置：** ✅ 合适。最小化、职责单一。

**问题：** 无。

---

### 55. `src/components/AuthorWorksPage.jsx` — 153 行 — **作者作品页**

**作用：** 全屏弹窗展示某画师的全部作品网格（调用 `pixivApi.fetchUserIllusts`），支持无限滚动和点击进入详情。

**依赖关系：**
- 导入：`pixivApi`、`registerBackHandler`、`gridThumbUrl`、`logger`
- 被谁用：`App.jsx`

**放置：** ✅ 合适。

**问题：**
- **手动重实现无限滚动**（不使用 `useTabFeed` 或 `ImageGrid`）
- `loadMore` 依赖 `loadingMore` 状态——每次 `loadingMore` 变化重建 callback
- GIF 类型检测用 `illustType === 2` 魔数
- 首次加载 `limit: 200` 硬编码

---

### 56. `src/components/DownloadMonitor.jsx` — 84 行 — **下载监视器 UI**

**作用：** 悬浮按钮（角标=活跃下载数）→ 点击展开毛玻璃全屏任务列表（进度条+状态）。

**依赖关系：**
- 导入：`downloadMonitor.js`、`useSyncExternalStore`
- 被谁用：`App.jsx`

**放置：** ✅ 合适。`useSyncExternalStore` 是 React 18 标准模式。

**问题：**
- Job key 含 `illustId_pageIndex`——重新下载同一作品时 key 可能重复导致 React reconciliation 错误
- `DownloadRow` 内部定义在此文件——可独立为组件

---

### 57. `src/components/detail/DetailView.jsx` — 82 行 — **详情页导航栈**

**作用：** 详情页包装器：维护浏览栈（push/pop）、滚动位置记忆、返回键处理、协调 DetailView→AuthorWorksPage 跳转。

**依赖关系：**
- 导入：`ImageDetailView`、`registerBackHandler`、`logger`
- 被谁用：`App.jsx`

**放置：** ✅ 合适。位于 `components/detail/`。

**问题：**
- `document.querySelector('.char-state-content')`——硬编码 DOM 结构
- `scrollMapRef` 从不清理——浏览数百张图后内存持续增长
- `initialImage` 比较仅用 `illustId`——同一作品不同页码时栈可能不重置

---

### 58. `src/components/detail/ImageDetailView.jsx` — 484 行 — **详情页核心**

**作用：** 图片详情主视图：堆叠多页面板、加载 API 详情+相关推荐、内嵌灯箱、LikeButton、UgoiraPlayer、保存全部页面。

**依赖关系：**
- 导入：`pixivApi`、`saveItem`、`storageFacade`、`LightboxActions`、`MediaLightbox`、`UgoiraPlayer`、`helpers.js`、`gridThumbUrl`、`registerBackHandler`、`logger`
- 被谁用：`DetailView.jsx`

**放置：** ✅ 合适。但 484 行职责过多。

**问题：**
- **O(n²) 去重**：`related.findIndex` 在 map 内——应用 Set 优化为 O(n)
- `lightboxMedia` IIFE 每次 render 重算——应用 `useMemo`
- `setTimeout(100ms)` 等待 DOM 布局——脆弱，应用 `ResizeObserver` 或 `requestAnimationFrame` 轮询
- `saveAllPages` 中 `saveItem` + `setPixivCache` 分别调用可能触发多次重渲染——应用 `startTransition` 批处理

---

### 59. `src/components/detail/helpers.js` — 56 行 — **详情工具**

**作用：** Pixiv API 数据→组件格式转换：`parsePixivResults`（展开多页为条目）和 `allMediaFromRelated`（推荐作品适配）。

**依赖关系：**
- 导入：`pixivReUrl`
- 被谁用：`ImageDetailView.jsx`

**放置：** ✅ 合适。

**问题：**
- `_msgId: 'pixiv-gallery'` 硬编码——疑似历史遗留
- `originalUrl` 回退逻辑与 `parsePixivResults` 不一致

---

### 60. `src/components/icons/HeartIcon.jsx` — 33 行 — **爱心图标**

**作用：** SVG 爱心图标，支持 filled/outline 两种状态，`currentColor` 继承颜色。

**依赖关系：**
- 导入：`React`
- 被谁用：`LightboxActions.jsx`

**放置：** ✅ 合适。

**问题：**
- `strokeWidth={0}` 在 filled 状态——SVG 规范要求 `stroke-width` 为正数

---

### 61. `src/components/icons/SearchIcon.jsx` — 22 行 — **搜索图标**

**作用：** SVG 放大镜图标，可调 size，`currentColor` 继承颜色。

**依赖关系：**
- 导入：无
- 被谁用：`SearchPage.jsx`

**放置：** ✅ 合适。

**问题：** 无。干净。

---

### 62. `src/index.css` — 765 行 — **全局样式**

**作用：** CSS 自定义属性（暗色主题）、全局 reset、布局框架（`.app`/`.app-content`）、TabBar、Grid、Chip、Modal、Toast、毛玻璃、进度条等通用组件样式。

**依赖关系：**
- 无
- 被谁用：所有组件（隐式全局）

**放置：** ✅ 合适。但 765 行过大。

**问题：**
- 两个 `:root` 块可合并
- 大量样式可迁移到 `styles/` 下的组件 CSS
- `.btn-primary` 定义两次（510 行和 623 行）
- 魔法 z-index 值散布（5/10/30/40/100/200/300/10000）
- 全局 `* { scrollbar-width: none }`——accessibility 不友好

---

### 63. `src/styles/detail.css` — 373 行 — **详情页样式**

**作用：** 详情页覆盖层 z-index 体系、布局（char-state-bar/content）、标题/作者/标签、图片堆叠块、相关推荐网格、GIF 覆盖层、悬浮喜欢按钮。

**依赖关系：**
- 被谁用：`App.jsx`（在 import 中加载）

**放置：** ✅ 合适。按 feature 拆分 CSS。

---

### 64. `src/styles/download.css` — 186 行 — **下载监视器样式**

**作用：** 下载悬浮按钮（.download-fab）、全屏毛玻璃 sheet、任务行、进度条（确定/不确定）。

**依赖关系：**
- 被谁用：`DownloadMonitor.jsx`

**放置：** ✅ 合适。

---

### 65. `src/styles/lightbox.css` — 286 行 — **灯箱样式**

**作用：** 灯箱全功能样式：覆盖层、关闭按钮、导航箭头、幻灯片轨道、图片包裹器、信息栏、玻璃按钮、入场动画。

**依赖关系：**
- 被谁用：`MediaLightbox.jsx`、`LightboxActions.jsx`

**放置：** ✅ 合适。

**问题：**
- `animation: lightboxIn` 引用但未在此文件定义
- 与 `index.css` 有 Ugoira 进度条样式重复

---

### 66. `src/styles/search.css` — 202 行 — **搜索页样式**

**作用：** 搜索栏毛玻璃风格、输入框、提交按钮/spinner、历史标签云、底部固定定位。

**依赖关系：**
- 被谁用：`SearchPage.jsx`

**放置：** ✅ 合适。

**问题：**
- 硬编码 `rgba(79, 140, 255, ...)` 代替 `--accent` CSS 变量——更换主题色需改 4+ 处
- `.search-bar--bottom` 定位矛盾（先 `margin: 0 auto` 再加 `left: 12px; right: 12px`）

---

## 附录：资产文件

| 文件 | 行数 | 用途 |
|------|------|------|
| `src/assets/react.svg` | - | Vite 模板遗留文件（未在应用中使用） |
| `src/assets/vite.svg` | - | Vite 模板遗留文件（未在应用中使用） |
| `src/assets/hero.png` | - | 应用 icon 或占位图 |

---

## 问题统计

| 严重程度 | 数量 | 典型问题 |
|----------|------|----------|
| 🔴 严重 | 6 | 双重状态管理、DOM 查询在 store 中、IIFE 全表扫描、O(n²)去重、3 个疑似死代码文件、零类型安全 |
| 🟡 中度 | 12 | 超大文件未拆分、useTabFeed 未全面采用、IndexedDB 迁移债、硬编码 magic number、barrel 重叠 |
| 🔵 轻度 | 15 | eslint-disable、命名遗留、SVG 规范、无 ARIA、CSS 缩进不一致、模块级可变状态 |

---

## 图例

| 标记 | 含义 |
|------|------|
| ✅ | 放置合适 |
| ⚠️ | 有问题但可接受 |
| 🔴 | 严重，需修复 |

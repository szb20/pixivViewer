# PixivViewer Code Wiki

> 本文档基于当前代码库（2026-10）完整分析生成，覆盖项目整体架构、主要模块职责、关键类与函数、依赖关系及运行方式。
> 更详细的分层设计讨论见 [architecture.md](architecture.md)。

---

## 目录

1. [项目概览](#1-项目概览)
2. [整体架构](#2-整体架构)
3. [目录结构](#3-目录结构)
4. [表现层（UI）](#4-表现层ui)
5. [状态管理层](#5-状态管理层)
6. [API 传输层](#6-api-传输层)
7. [多图源适配层（src/sources）](#7-多图源适配层srcsources)
8. [业务逻辑层（pixiv-assistant/core）](#8-业务逻辑层pixiv-assistantcore)
9. [存储层（pixiv-assistant/capacitor）](#9-存储层pixiv-assistantcapacitor)
10. [动图（Ugoira）链路](#10-动图ugoira链路)
11. [下载与保存体系](#11-下载与保存体系)
12. [工具层（src/utils）](#12-工具层srcutils)
13. [关键数据模型](#13-关键数据模型)
14. [典型数据流](#14-典型数据流)
15. [平台壳：Android / Electron / Web](#15-平台壳android--electron--web)
16. [开发代理中间件（scripts/）](#16-开发代理中间件scripts)
17. [依赖关系总览](#17-依赖关系总览)
18. [构建与运行](#18-构建与运行)
19. [开发规范与已知注意事项](#19-开发规范与已知注意事项)

---

## 1. 项目概览

**PixivViewer** 是一个个人自用的图片浏览 / 下载应用，从 llm-chat 项目独立出来。核心特性：

- **多图源浏览**：Pixiv 之外还支持 yande / konachan / konachan-net / danbooru / safebooru / wallhaven 共 7 个来源
- **四个浏览入口**：推荐（discover）/ 排行（ranking）/ 我（me）/ 搜索（search），双列瀑布流 + 无限滚动 + 下拉刷新
- **多图详情页**：全部页面上下堆叠、进入视口懒加载原图、本地相册优先
- **全屏灯箱**：滑动翻页 / 双击与双指缩放 / 惯性滑动
- **Ugoira 动图**：浏览器端 ZIP 解帧播放（fflate 流式解压），支持 gifenc 编码保存为 GIF
- **下载到相册**：IndexedDB 元数据 + Capacitor Filesystem / MediaStore 文件，带下载监控与失败重试
- **跨卸装备份**：喜欢/已保存元数据写 Downloads JSON + 相册 PNG 副本，重装可恢复
- **三端运行**：Web（Vite dev）/ Android（Capacitor APK）/ Windows 桌面（Electron）

**技术栈**：

| 类别 | 技术 |
|---|---|
| 前端框架 | React 19 + Vite 8 |
| 状态管理 | Zustand 5 + React Context（拆分订阅）+ 模块级单例 store |
| 原生壳 | Capacitor 8（Android）/ Electron 33（Windows） |
| 网络 | CapacitorHttp / 原生 StreamingDownload 插件 / Electron 主进程 Node https |
| 图像处理 | fflate（ZIP 流式解压）、jszip（缓冲解压）、gifenc（GIF 编码） |
| 持久化 | IndexedDB（2 个库）+ localStorage + MediaStore / 文件系统 |
| 代码规范 | oxlint |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     表现层 Presentation                       │
│  App.jsx（装配中枢）/ pages / components / hooks / styles     │
├─────────────────────────────────────────────────────────────┤
│                     状态层 State                              │
│  useAppStore(zustand) / PixivCacheProvider(Context×2)        │
│  useImageSource(模块单例) / downloadMonitor(框架无关单例)      │
├─────────────────────────────────────────────────────────────┤
│                API 层 + 多图源适配层                           │
│  api/transport.js(三通道工厂) ── sources/(7 来源注册表+适配器) │
│  api/pixiv.js / ugoira/ / index.js(saveItem) / save*.js      │
├─────────────────────────────────────────────────────────────┤
│           业务逻辑层 Business（纯逻辑，无平台依赖）              │
│  pixiv-assistant/core/                                       │
│  ├─ pixivApi.js（API 工厂，组装 core/pixiv/* 六个端点模块）     │
│  ├─ utils.js（URL/ID/文件名 纯函数）                           │
│  └─ constants.js / types.js                                  │
├─────────────────────────────────────────────────────────────┤
│              存储层 Storage（平台实现）                        │
│  pixiv-assistant/capacitor/                                  │
│  ├─ storageFacade.js（UI 门面 + 并发去重）                     │
│  ├─ storageService.js（业务编排）                             │
│  ├─ repository.js（Entity↔IndexedDB 映射）→ cacheDB.js        │
│  ├─ fileStore.js（文件+路径规则）→ gallery.js（MediaStore/桌面）│
│  ├─ networkStore.js（下载降级链）                              │
│  ├─ metaBackup.js（跨卸装备份） / tabCache.js（Tab 缓存）      │
│  └─ entity.js（PixivEntity 统一模型） / config.js（配置中心）   │
├─────────────────────────────────────────────────────────────┤
│              工具层 Utility                                   │
│  utils/（platform 收口 / toast / logger / scroll / …）        │
├─────────────────────────────────────────────────────────────┤
│              服务层 Server（dev / Electron 壳内）              │
│  scripts/（Vite 代理中间件：pixiv + booru 路由表）             │
└─────────────────────────────────────────────────────────────┘
```

**核心设计原则**：

1. **核心逻辑与平台解耦**——`core/` 是纯函数，不依赖任何平台 API；`createPixivApi(transport)` 工厂接收 Transport 接口，平台差异只影响传输实现。
2. **能力声明驱动 UI**——`sources/registry.js` 的 `caps` 字段是 UI 分支唯一依据，禁止散落 `source === 'pixiv'` 判断。
3. **跨源 ID 全局唯一**——`qualifyId` 为非 pixiv 来源的 illustId 加 `{source}_` 前缀，避免与 pixiv 数字 id 撞号（yande 约 127 万条 id 落在 pixiv id 区间内）。
4. **错误双契约**——传输层抛带 `.status` 的结构化错误（`httpError`）；sources 层所有方法不抛异常，经 `classifyError` 转中文文案放进返回值。
5. **过期响应防御**——所有翻页/切换场景遵循「await 之后先验 stale 再推进游标/写状态」（`loadSeqRef` / `isStale()` / `fetchSeqRef` 模式）。

---

## 3. 目录结构

```
pixivViewer/
├── capacitor.config.ts        # Capacitor 配置（默认本地 assets，CAP_DEV=1 走 dev server）
├── vite.config.js             # Vite 配置（代理注册、端口 5182、cssTarget chrome110）
├── package.json               # 脚本：dev / build / desktop / desktop:dev / desktop:build
├── index.html
├── src/
│   ├── main.jsx               # 入口（StrictMode + PixivCacheProvider + StatusBar 适配）
│   ├── App.jsx                # 装配中枢（Tab 保活、覆盖层平铺、下拉刷新）
│   ├── api/                   # 传输适配（transport 三通道工厂）、动图下载、统一保存入口
│   ├── pages/                 # 推荐 / 排行 / 我 / 搜索 / 设置
│   ├── components/            # 网格、灯箱、详情（detail/）、面板（panels/）、动图播放器等
│   ├── pixiv-assistant/       # 核心业务逻辑与存储层
│   │   ├── index.js           # barrel 出口
│   │   ├── core/              # 纯逻辑（API 工厂、URL/ID/文件名工具、常量）
│   │   │   └── pixiv/         # 按端点拆分的 8 个模块（client/illust/search/…）
│   │   └── capacitor/         # 平台实现（IndexedDB、文件系统、网络下载、备份）
│   ├── sources/               # 多图源：registry + 4 协议适配器 + 公共件
│   ├── store/                 # zustand 全局状态（useAppStore）
│   ├── context/               # 喜欢 / 缓存状态 Context（拆 2 个 context）
│   ├── hooks/                 # useTabFeed 等 14 个公共钩子
│   ├── utils/                 # 平台收口、返回键、Toast、下载监控、日志等 19 个
│   └── styles/                # base/（tokens/shell/…）+ 页面级 css
├── scripts/                   # Vite 代理中间件（pixiv + booru，被 Electron 壳复用）
├── electron/                  # 桌面壳（main.cjs / preload.cjs / builder 配置）
├── android/                    # Android 原生工程（MainActivity + 2 自定义插件）
└── docs/                       # 架构文档（architecture.md 等）
```

---

## 4. 表现层（UI）

### 4.1 装配中枢 [App.jsx](../src/App.jsx)

- `TABS = [discover, ranking, me, search]`，与 `TAB_PAGES` 映射一一对应，加 tab 只需补一行。
- **Tab 懒挂载 + 保活**：`visitedTabs` 记录已访问 tab，首次访问才挂载；非当前 tab 用 `display: none` 隐藏（保持 DOM/滚动位置）。
- **按来源重挂载**：tab-pane 外层 `<ErrorBoundary key={activeSource:key}>`，切换图片来源时整块重挂载，列表/游标/滚动位置/内存缓存天然重置。
- **覆盖层平铺**：SettingsPage / DetailView / AuthorWorksPage / ProxyCheckNotice 都是全局状态驱动的兄弟节点，靠 z-index 与 `closeOverlays()` 协议管理。
- dev 模式注入 `window.__pixivViewer` 调试对象（storageFacade / openDetail / downloadMonitor）。

### 4.2 页面（src/pages/）

| 页面 | 职责 | 关键实现点 |
|---|---|---|
| **DiscoverPage** | 推荐流 | `useTabFeed` 骨架；pixiv 循环拉取凑满一页，三重过滤（已显示/不想看/启动前已收藏），连续 3 页无新内容才断流；booru 翻页即 `page+1` |
| **RankingPage** | 排行榜 | **未用 useTabFeed**（自实现）：内存档位缓存 Map（切档秒开）、`fetchSeqRef` 防旧响应覆盖；booru 的 popular 一次返回整批不翻页 |
| **MePage** | 「我」聚合页 | 四面板（following / subscriptions / liked / bookmarks）+ 子 tab 保活；聚合刷新——在 `'me'` 键注册一个回调转发给当前活跃子面板 |
| **SearchPage** | 搜索 | 历史（上限 12 条）；桌面端悬浮搜索框（portal）；`searchSeed` 支持详情页点 tag 跳转搜索；pixiv 纯数字/链接自动按 ID 直查 |
| **SettingsPage** | 设置 | 即时保存（`saveChain` 串行队列规避读-改-写竞态）；分组：账号 Cookie / 来源 / 网络 / 布局 / 保存（桌面专属） |

### 4.3 核心组件（src/components/）

**详情链路**（三层结构）：

| 组件 | 职责 |
|---|---|
| **DetailView** | 包装层：作品栈（相关推荐点图压栈/弹栈）、左右切换导航、按栈层记忆滚动位置（锚点 + delta）、离场动画（animationend 驱动卸载）、横滑切作品手势、方向键切换 |
| **ImageDetailView** | 内容层：fetchIllust 取详情；档位策略（手机 540px / 桌面 master1200 或复用原图）；相关推荐（模块级 LRU 缓存 20 条）；元数据回填（fillMeta）；灯箱候选链（本地 blob → originalUrl → master1200 → 短链） |
| **DetailPageBlock** | 单页块：三层图（缩略底座 → 预览主图 → hd 懒加载层）、比例校准缓存、长按 500ms 下载该页、`data-fit=0` 放行长条漫 |

**网格与媒体**：

| 组件 | 职责 |
|---|---|
| **ImageGrid** (memo) | 网格容器：过滤 hiddenWorks、构建红心集合、包装 `{items, index}` 导航上下文、提供 ✕ 隐藏入口 |
| **MasonryFeed** | 全站唯一瀑布流实现（首页与相关推荐共用）：ResizeObserver 动态列数 `max(2, round(w/250))`、比例钳制 0.5~1、贪心分配最矮列 |
| **GridItem** (memo) | 卡片：长按 500ms、shimmer 占位、失败可点击重试、`img.complete` 手动补查（React 丢失 onLoad 的挂载竞态） |
| **MediaLightbox** | 全屏灯箱（portal 到 body）：手势委托 useTouchGesture；只渲染当前 ±2 张 slide；图片候选链降级 + `?r=` 缓存穿透重试（上限 3 次）；托底小图；GIF → GifPlayer；视频四类降级（doujin/iwara/bilibili/直连） |
| **FrameAnimPlayer** | 动图共享实现（原两个 ~400 行播放器合并），UgoiraPlayer / GifPlayer 是参数化薄包装（差异见 §10） |
| **AuthorWorksPage** | 作者作品页：首屏 200 条 + 剩余 ID 触底分批（12 个并发）；失败 ID unshift 回队头；404 丢弃不重试 |
| **DownloadMonitor** | 下载管理：悬浮按钮 + 全屏弹窗；分组（进行中/失败/已完成）；大小/速度只在真有字节数时显示；一键重试 |
| **PullToRefresh** | 下拉刷新：阈值 64px、阻尼 0.6、touchcancel 复位（来电/通知栏打断） |
| **TabBar / SideNav** | 手机底部导航 / 桌面侧边栏（来源组、二级菜单、下载角标） |
| **panels/** | Me 页四面板：FollowingPanel / FollowingAuthorsPanel（每作者 12 张近期作品，MAX_CONCURRENT=3 有限并发）/ LikedPanel（本地 IndexedDB 分页 + 老记录后台回填）/ BookmarksPanel |

---

## 5. 状态管理层

**双 store + 单例架构**：

| 状态 | 位置 | 说明 |
|---|---|---|
| UI/导航状态 | `store/useAppStore.js`（zustand） | activeTab、detailImage、authorWorks、searchSeed、覆盖层开闭、scrollPositions、rankingCategory/R18 等 |
| 喜欢/已保存缓存 | `context/PixivCacheProvider.jsx` | **拆 2 个 context**：`PixivCacheContext`（读写层）+ `PixivLikedSetContext`（likedSet 只读派生） |
| 图片来源 | `hooks/useImageSource.js`（模块单例） | 'pixiv'/'yande'/…；`useSyncExternalStore` 桥接 React |
| 下载队列 | `utils/downloadMonitor.js`（框架无关单例） | `useSyncExternalStore` 桥接（useDownloadJobs） |

### 5.1 useAppStore 关键 action

- `setActiveTab(key)`：存滚动位置；点当前 tab 时——有覆盖层则只关覆盖层、无则 `tabTokens[key]++` 强刷
- `openDetail(img, context)` / `closeDetail()`：`normalizeDetailContext` 校验 index；`returnToAuthor` 支持从作者页进详情后关详情回作者页
- `selectRankingCategory` / `toggleRankingR18`：经 `nextRankingSelection` 联动（R18G 自动开、无 R18 变体自动关）
- `closeOverlays()`：切来源时必须先调用
- `searchByTag(tag)`：详情页点 tag → 切搜索页 + 写 searchSeed

### 5.2 PixivCacheProvider 启动序列

```
hiddenWorks.init() → ensureGalleryReadPermission() → restoreMetaBackupIfNeeded()
→ ensureMetaBackup() → reconcileGallery() → storageFacade.getAll()
→ 合并式写入 pixivCache（保住扫描期间乐观更新）→ cacheReady = true
```

- 键为复合键 `${illustId}_${pageIndex}`。
- `recommendationExcludedSet`：启动时一次性生成的已收藏快照，会话中新增收藏**不**从当前推荐流剔除（下次启动才生效）。
- `likedSet` 派生用结构相等缓存：Set 成员不变则复用旧引用 → 无关变化不触发网格重渲染。

---

## 6. API 传输层

### 6.1 [transport.js](../src/api/transport.js) — 三通道工厂（两层共享的地基）

`createTransport(opts)` 为每个站点生成传输实例，运行时按平台自动选择通道：

```
isDesktopShell() ? desktopFetch : (IS_DEV ? devFetch : prodFetch)
```

| 通道 | 实现 | Cookie | UA/Referer |
|---|---|---|---|
| `devFetch` | `fetch('/pixiv-api...')` 走 Vite 同源代理 | 浏览器禁设 → 转 `x-pixiv-cookie` 头由代理还原 | 不设（代理侧设置） |
| `desktopFetch` | `fetch('http://127.0.0.1:{port}...')` 走 Electron 壳内代理 | 同 dev | 同 dev |
| `prodFetch` | `CapacitorHttp.request()`（原生 HTTP 栈），失败降级普通 fetch | 可直设，原样保留 | 显式注入（Referer=origin、UA=DESKTOP_UA） |

关键导出：

- `httpError(status, pathname)` — 返回带 `.status` 的 Error。**错误契约：上层按 `err.status` 分类，不解析消息字符串**（历史教训：解析 `'net::ERR_...'` 里的 "HTTP" 导致误判）。
- `makeBuildHeaders` 内部机制 — `FORBIDDEN` 集合丢弃浏览器禁设头（cookie/referer/user-agent）；`cookieAs` 参数控制 dev 下 Cookie 转自定义头。

### 6.2 [pixiv.js](../src/api/pixiv.js) — Pixiv 装配

- `pixivTransport = createTransport({ apiPrefix: '/pixiv-api', origin: 'https://www.pixiv.net', cookieAs: 'x-pixiv-cookie' })`
- `pixivApi = createPixivApi({ fetch: pixivTransport, getCookie, log })` — 全应用共用的 API 实例
- `getCookie()`：从 settings 读 `pixivCookie`，容错去掉 `PHPSESSID=` 前缀

### 6.3 [index.js](../src/api/index.js) — saveItem 统一保存入口

```js
saveItem(item) → storageFacade.saveFromNetwork(item)   // 动图/静图分流已下沉到 storageService
```

**断言式分流**在 `storageService.saveFromNetwork` 入口：`pixiv && (type==='gif' || illustType===2)` 走 `_saveGifFromNetwork`（Ugoira 通道），booru 来源恒走静图分支（booru 无 ugoira_meta 接口，误入必然 404），双重保险（`_doSaveGif` 内部也拒绝 booru）。

### 6.4 保存编排

| 文件 | 职责 |
|---|---|
| `saveAllPages.js` | 保存作品全部页：booru 恒单页**绝不调用 pixivApi.fetchIllust**（同号顶包）；分批并发 `SAVE_BATCH_SIZE=3`；每页带 `_silent` 由调用方汇总提示 |
| `saveSingle.js` | 非多页来源单条保存直通 |

---

## 7. 多图源适配层（src/sources）

### 7.1 架构

```
registry.js（SOURCES 声明式注册表：caps + net + kind）
     │
api.js（booruApiFor 门面：kind → 工厂分发 + 单例缓存；pixiv 返回 null）
     ├─ moebooru.js  → yande / konachan / konachan-net
     ├─ danbooru.js  → danbooru
     ├─ gelbooru.js  → safebooru
     └─ wallhaven.js → wallhaven

shared.js（公共件）    imageUrl.js（dev 图床代理改写）
```

**新增图源 = registry 加一条 SourceDef + 新协议写一个适配器 + api.js 的 FACTORIES 补一行。**

### 7.2 registry.js — SourceDef 结构

```js
{
  id, label, shortLabel,
  kind,                          // 适配器类型（pixiv/moebooru/danbooru/gelbooru/wallhaven）
  caps: {                        // 8 个能力位 —— UI 分支唯一依据
    feed, ranking, search, multiPage,
    follow, related, ugoira, accountTabs
  },                             // 只有 pixiv 全 true，其余 6 源均为 feed/ranking/search
  net: { apiOrigin, apiPrefix, imgHosts, userAgent? },
}
```

- `getSource(id)`：未知 id **兜底 pixiv**（历史数据兼容）。
- `capsOf(id)`：UI 问能力不问来源名。

### 7.3 适配器统一接口（duck-typing，无基类）

```js
{
  id, def,
  rankingModes: [{key, label}],       // moebooru 无此字段
  search(query, {page, limit, safeOnly}) → {images, query, total?, error?}
  feed({page, limit, safeOnly})       → {illusts, message?}
  popular({period, limit, safeOnly?}) → {illusts, error?}
  fetchIllust(illustId)              → {illust: toIllust 形状|null, error?}
}
```

所有方法**不抛异常**；`fetchIllust` 同时接受带前缀与裸站点 id。每个适配器内部各自 `createTransport(...)` —— **与 api/pixiv.js 共用同一个传输工厂**。

### 7.4 各适配器要点

| 适配器 | 站点 | 关键行为 |
|---|---|---|
| **moebooru** | yande / konachan / konachan-net | `score:>=20` 近期高分作推荐流（不用 `order:score`——榜首常年是十几年前的图）；konachan.net 在 CF 后面，走 booru-proxy Node 通道正常 |
| **danbooru** | danbooru.donmai.us | 必须非浏览器 UA（`API_CLIENT_UA`，CF 拒「Chrome UA + 非浏览器 TLS 指纹」）；匿名 2 tag 上限（超出截断不报错）；`file_url` 为空（banned）整条丢弃；标题选取角色→作品→首个 tag |
| **gelbooru** | safebooru.org | 单端点 dapi；分页 pid 0 基；排序拼进 tags 元标签；`score:>=10` 近期高分；DAPI 无作者字段 |
| **wallhaven** | wallhaven.cc | 唯一官方 REST API；categories='010' 只出 anime；mediumUrl 直接给原图（缩略图全是固定比例裁剪，比例是错的）；6 位字母数字 id 只认链接形态 |

### 7.5 跨文件同步约束（三处影子副本）

1. `scripts/booru-proxy.mjs` 的路由表 ↔ registry.net（前缀/host/UA 三样对齐）
2. `core/utils.js` 的 `KNOWN_SOURCES` 封闭词表
3. ~~`gif.js` 与 `pixiv.js` 各自实现的 `getCookie`~~ ✅ 已收敛到 `capacitor/config.js` 的 `getPixivCookie`（pixiv.js 与 ugoira/meta.js 共用）

一致性由 `scripts/check-sources.mjs` 断言守护。**来源 id 不得含下划线**。

---

## 8. 业务逻辑层（pixiv-assistant/core）

### 8.1 [pixivApi.js](../src/pixiv-assistant/core/pixivApi.js) — API 工厂

```js
createPixivApi({ fetch, getCookie, log })
  → client = createApiClient(transport)     // 基础设施
  → ctx = { ...client, transport, log }
  → 组装 illust / search / ranking / feed / user / social 六组端点
  → 返回扁平合并的 13 个 API 函数
```

**Transport 接口**（宿主注入）：`fetch(pathname, opts) → Promise<JSON|text>` + `getCookie()` + `log`。core 不反向依赖 utils/logger（日志由外层注入）。

**最终 API 面**：

| 函数 | 模块 | 说明 |
|---|---|---|
| `searchPixiv(query, {page, count})` | search | 纯数字 ≥6 位或链接 → 按 ID 直查（复用 fetchIllust LRU）；否则 `/ajax/search/artworks/` |
| `searchPixivUser(keyword)` | search | `/ajax/search/user/`，前 5 条 |
| `fetchIllust(illustId)` | illust | `/ajax/illust/{id}` + 多图再取 `/pages`；**LRU 缓存 50 条 / 5 分钟** |
| `randomIllust()` | illust | 搜 `10000users入り` 从前 30 条随机取 1 |
| `fetchRelated(illustId, {limit})` | illust | `/ajax/illust/{id}/recommend/init`（需 Cookie，不可翻页） |
| `fetchDiscovery({limit, start})` | feed | `/ajax/discovery/artworks`（需 Cookie） |
| `fetchBookmarks({tag, offset, limit})` | feed | `/ajax/user/{id}/illusts/bookmarks`（需 Cookie） |
| `fetchFollowing({page})` | feed | `/ajax/follow_latest/illust`（需 Cookie） |
| `fetchUserIllusts(userId, {limit})` | user | `/ajax/user/{id}/profile/top`（含缩略图） |
| `fetchUserIllustIds(userId)` | user | `/ajax/user/{id}/profile/all`（供分页） |
| `fetchUserProfile(userId)` | user | `/ajax/user/{id}` |
| `fetchRanking({mode, page})` | ranking | `/ranking.php?format=json`（有 Cookie 注入，R18 需登录） |
| `followUser` / `unfollowUser` / `fetchFollowingUsers` | social | POST + **CSRF token**（失效自动重取重试 1 次） |

**错误约定**：所有函数不抛异常，失败返回含 `error` 字段的对象（`classifyError` 中文文案）；需登录端点先 `ensureCookie`。

### 8.2 core/pixiv/client.js — 基础设施

- `createApiClient(transport)` → `{ apiFetch, ensureCookie, getCsrfToken, invalidateCsrfToken, classifyError }`
- `getCsrfToken()`：GET `/` 原始 HTML 提取 `api.token`，缓存 10 分钟（跨实例共享）
- `classifyError(err, context)`：网络类→「网络连接失败」、403→「Cookie 可能已过期」、404→「作品未找到」、429→「请求过于频繁」等

### 8.3 [core/utils.js](../src/pixiv-assistant/core/utils.js) — 纯函数工具集

**URL 构造**：`pixivReUrl`（短链）、`proxyThumb`（pximg→pixiv.re 替换）、`pixivPageUrl`（master 图档位推导）、`pixivOriginalUrl`（原图档）

**ID 体系**（跨层粘合剂）：

| 函数 | 说明 |
|---|---|
| `qualifyId(source, rawId)` | pixiv 保持裸数字（零迁移）；其他加 `{source}_` 前缀 |
| `sourceOfId(illustId)` | 按第一个下划线切分 + KNOWN_SOURCES 白名单校验，未知兜底 pixiv |
| `rawIdOf(illustId)` | 剥来源前缀（**拼文件名必须用它**） |
| `getCompositeKey(img)` | `` `${illustId}_${pageIndex}` `` |

**文件名契约**（一对互逆函数，必须放在一处防漂移）：

- `buildCacheFileName(entity)` → `{source}_{rawId}_p{pageIndex}_[{author}]_[{title}].{jpg|gif}`，总预算 240 字节（Android MediaStore/ext4 单文件名上限 255 **字节**）
- `parseCacheFileName(name)` → 按序匹配 8 种历史/现行格式的逆解析
- 辅助：`utf8ByteLen` / `truncateUtf8Bytes`（按字节截断不切碎多字节字符）、`safeFileName`

---

## 9. 存储层（pixiv-assistant/capacitor）

### 9.1 分层

```
StorageFacade（UI 门面：参数校验 + 并发去重 _saveInFlight）
  └─ PixivStorageService（业务编排，不含实现）
       ├─ PixivRepository（Entity ↔ IndexedDB 映射）→ cacheDB.js
       ├─ FileStore（文件 + 路径规则）→ gallery.js（MediaStore / 桌面）
       ├─ NetworkStore（下载降级链）
       └─ metaBackup（跨卸装备份，防抖触发）
```

### 9.2 [storageFacade.js](../src/pixiv-assistant/capacitor/storageFacade.js) — UI 门面

单例。`saveFromNetwork(item)` 按 `${illustId}_${pageIndex}` **并发去重**：自动保存 + 手动保存同一张图共享同一 in-flight promise，只下载一次。其余方法（load / listLiked / toggleLike / like / unlike / fillMeta / backfillMeta / getAll）为校验 + 透传。

### 9.3 [storageService.js](../src/pixiv-assistant/capacitor/storageService.js) — 业务编排

**`saveFromNetwork(item)`（UI「保存」唯一入口，静态图）**：

```
① 已有记录且有 fileName → _promoteToSaved（幂等：galleryHasFile 实际探测相册，
   缺失则用私有副本重导出，都没有返回 file_missing）
② 已有轻记录（无 fileName）→ 删掉重建但保留 likedAt
③ 清洗标题 → probe 文件名探测相册，命中 → 跳过下载直接建 saved 记录
④ buildDownloadUrls 候选逐个下载（downloadMonitor 全程挂钩）
⑤ 建 saved entity → fileStore.save → repository.save → scheduleMetaBackup
```

**`buildDownloadUrls(item)`**：非 pixiv 来源直接用 `fetchableImageUrls`，**绝不回退 pixivReUrl**（否则同号 pixiv 作品顶包存下无关图）；pixiv 优先从 originalUrl/mediumUrl 提取日期路径构造 `i.pixiv.re/img-original/...`，兜底短链。

**`_findEntity(illustId, pageIndex)`**：精确匹配；页 > 0 时**仅动图**允许回退页 0（动图统一存页 0）。

### 9.4 [entity.js] — PixivEntity 统一数据模型

| 字段 | 说明 |
|---|---|
| `id` | `makeId(illustId, pageIndex)` → `'{source}:{illustId}:{pageIndex}'`（source 一律从 illustId 派生） |
| `state` | `'cached' \| 'saved'`（无 deleted 状态，delete = 删文件 + 删 meta） |
| `type` | `'image' \| 'gif'` |
| `fileName` | buildCacheFileName 产物；**为空即「轻记录」**（喜欢未下载的作品） |
| `likedAt` | >0 即已喜欢；三重身份：喜欢布尔 + 喜欢页排序键 + 备份合并就高字段 |
| 其余 | title / author 系列 / tags / cachedAt / size / frames / pageCount / 各档 URL / flags / webUrl |

实例方法：`isGif / isCached / isSaved / isLiked`（getter）、`withState`（不可变风格）、`toRecord`（IndexedDB record）；静态：`makeId / parseId / fromRecord`。

### 9.5 [repository.js] — 对象映射

上层只和 Entity 打交道，不知道 IndexedDB 存在（将来换 SQLite 只改此文件）。

关键方法：`save / saveBatch / find / findByIllustId / listByState / listLiked / delete / changeState / fillMeta（幂等回填）/ toggleLike / like（幂等，已喜欢不动 likedAt）/ unlike（幂等，保留记录与已保存状态）/ stats / getAll`

**轻记录机制**：喜欢未下载作品 → 立即建无 fileName 的 cached 记录（带展示元数据）；后续保存删轻记录重建并保留 likedAt。

### 9.6 [cacheDB.js] — IndexedDB 直接访问层

库 `teyvat_pixiv_cache_v2`（版本 1），仓库 `metadata`（keyPath `cacheKey`），7 个索引：

| 索引 | 用途 |
|---|---|
| `illustId` | 同作品全页查询 |
| `state` | 按状态计数 |
| `stateCachedAt`（复合） | state 内按 cachedAt 倒序游标分页 |
| `likedAt` | ≥1 计数 + 倒序分页（喜欢页） |
| `tags`（multiEntry） | 按标签搜索（未接线，底层直供） |
| `cachedAt` / `author` | 已建未用 |

所有公开函数**失败不抛出**，降级返回空值。`openDB()` 防御：幂等建库、onblocked 3 秒宽限降级、迟到连接 close。

### 9.7 [fileStore.js] — 文件与路径规则

- 唯一所有者原则：不对外暴露路径规则，上层只传 entity + state。
- `save`：cached → 写应用私有存储 `DATA/PixivViewer/`；saved → **只 exportToGallery（MediaStore），不写私有副本**（避免双写）。
- `load`：双通道——先私有存储，失败再相册；base64 → Blob → objectURL。
- `delete`：删私有文件；saved 时同时删相册。

### 9.8 [gallery.js] — 系统相册通道

Android 走原生 `GallerySaver` 插件（MediaStore，免存储权限）；桌面 Electron 走 `window.desktopProxy.saveFile`（系统保存对话框/直接落盘）。整体尽力而为：失败只记日志。

### 9.9 [networkStore.js] — 下载降级链

`downloadImage(url, onProgress)` 通道优先级：

```
① 桌面壳 desktopDownload（主进程 Node 流式，真实字节进度）
② 非 DEV 且原生可用 → nativeDownload（Android 原生流式，真实进度）
③ CapacitorHttp（故意不报进度——原假进度估算方案已废弃，「宁可没有，也不给假数」）
DEV: fetch（带 Referer + 60s 停滞兜底）失败降级 CapacitorHttp
```

Referer 策略：仅 pximg/pixiv.re 域名带 `https://www.pixiv.net/`（booru 图床不校验）。

### 9.10 [metaBackup.js] — 跨卸装备份

解决「IndexedDB 随卸载清空、相册文件保留」问题：

- **写**：`scheduleMetaBackup()`（1.5s 防抖）→ 过滤 liked/saved 记录 → JSON 写 Downloads 集合 + 「1×1 PNG 尾部藏 JSON」写相册（Pictures，跨重装恢复的关键载体）。
- **恢复**：`restoreMetaBackupIfNeeded()` 幂等三路：空库全量导入 / 喜欢自愈合并 / 不覆盖。
- **对账**：`reconcileGallery()` 扫描相册，为「有文件无元数据」补建 saved 记录。
- **安全边界**：备份绝不写入 Cookie（可被任意有媒体读权限的 App 读到）。
- `BACKUP_VERSION = 5`（条目带 source 字段）；多份备份合并：likedAt 取最大、cachedAt 取新、state 就高。

### 9.11 [tabCache.js] — Tab 结果缓存

库 `teyvat_pixiv_tabs`（版本 3），仓库 `tabs`（keyPath `key`），记录 `{key, data, updatedAt}`，**TTL 24 小时**。`scopedTabKey(source, key)` 加来源前缀（切换来源不串列表）。升级 v1→v2→v3 均 clear 重拉。

### 9.12 [config.js] — 配置中心

- `getSettingsSync()` 合并默认值：`proxyUrl`（默认 `http://127.0.0.1:7890`）、`pixivCookie`、`gridLayout`、`saveDirectory`、`saveAskEachTime`、`imageSource`、`booruSafeOnly`
- `configurePixiv({getSettings, getFS})` 支持宿主注入适配器（Electron/测试）
- `getFS()` 仅原生平台动态 import `@capacitor/filesystem`
- ⚠️ `buildCookie` 构建期 Cookie 注入为**测试期临时方案**（`VITE_PIXIV_COOKIE` / `VITE_DEV_COOKIE`），发版前必须删除

---

## 10. 动图（Ugoira）链路

原 823 行 `api/gif.js` 已拆为 `api/ugoira/` 七模块 —— **只管「看」**（取帧给播放器），
**保存链路**（取帧 → GIF 编码 → 相册导出）归 `storageService._saveGifFromNetwork` / `_doSaveGif`。

| 模块 | 职责 |
|---|---|
| [index.js](../src/api/ugoira/index.js) | `fetchUgoiraFrames` 编排 + in-flight 去重（进度只增不减），re-export 缓存查询 |
| [framesCache.js](../src/api/ugoira/framesCache.js) | 帧内存 LRU（12 个，blob URL 显式回收） |
| [meta.js](../src/api/ugoira/meta.js) | ugoira_meta 查询（自建 transport 实例，防 `storageService → ugoira → pixiv.js → barrel → storageFacade` 环） |
| [zipDownload.js](../src/api/ugoira/zipDownload.js) | ZIP 流式（prod 主路径，90s 停滞检测）/ 缓冲下载（dev 代理 / 回退），pximg → pixiv.re 改写 |
| [unzip.js](../src/api/ugoira/unzip.js) | fflate 解帧：流式解压器（网络/磁盘共用）+ 整包解帧（原 JSZip 路径，已由 fflate 整包喂入替代） |
| [zipDiskCache.js](../src/api/ugoira/zipDiskCache.js) | ZIP 磁盘缓存（12 个 / 40MB 上限 / 2MB 分块 IO / mtime LRU）+ 无损 ZIP 相册备份 |
| [gifEncoder.js](../src/api/ugoira/gifEncoder.js) | gifenc 编码（共享调色板 + 逐帧流水释放像素） |

**`fetchUgoiraFrames(illustId, onProgress)`** 播放主入口：

```
内存 LRU 缓存（framesCache，12 个，blob URL 显式回收）
  ├─ 命中 → 直接返回
  └─ 未命中 → in-flight 去重（进度只增不减）
       → 磁盘 ZIP 缓存（zipDiskCache：12 个 / 40MB 上限 / 2MB 分块 IO / mtime LRU）
       ├─ 命中 → 分块读 + fflate 解帧
       └─ 未命中 → fetchUgoiraMeta（meta.js）→
            ├─ prod：streamUgoira 流式边下边解（i.pixiv.re 直连，90s 停滞检测）
            │         失败回退 → downloadZip + extractFramesFromBuffer（fflate 整包）
            └─ dev：downloadZip（/pixiv-zip 代理）+ extractFramesFromBuffer
```

**动图保存**（`storageService._saveGifFromNetwork` → `_doSaveGif`）：

```
下载监控（monitor key {sid}_0）+ 失败登记 failMeta（一键重试）
→ 幂等检查（repo.find）→ 相册同名跳过（galleryHasFile，最多补拉一次 meta）
→ fetchUgoiraFrames → 第 0 帧载入像素
→ encodeFramesToGif（共享调色板：第 0 帧 quantize(256) 一次，全帧复用；
   每帧写完立即释放像素 → 内存峰值 ≈ 一帧；进度 60→90）
→ bytesToBase64（分块）→ exportToGallery（只导 MediaStore 不写私有副本）
→ repo.save(buildGifEntity) → scheduleMetaBackup
成功后异步把无损原版 ZIP 也复制到相册（pixiv_{id}_ugoira.zip，尽力而为）
```

并发去重由 `storageFacade` 完成（动图统一页 0，与静图共用 `${illustId}_0` 键）。
文件名 `pixiv_{id}_g0_[{author}]_[{title}].gif`（`buildGifFileName`，core/utils.js），
按 UTF-8 字节截断（预算 240 字节，日文标题每字 3 字节）。
⚠️ 保留 `g0` 历史格式：改成 `p0` 会让相册同名幂等对已保存动图失效。

### 10.2 FrameAnimPlayer — 共享播放器

原 UgoiraPlayer / GifPlayer 两个 ~400 行播放器合并，差异开关参数化：

| 开关 | UgoiraPlayer | GifPlayer |
|---|---|---|
| progressBar | 线性 | 环形 SVG |
| stallTimeout | 无 | 90s 看门狗（仅无任何进度才超时） |
| debounceToggle | 否 | 是（300ms，防双触发） |
| capByMaxHeight / capWidthByCanvas | / | 0.75 屏高 / 宽不超首帧 |
| clearCacheOnError | 是 | 否 |

机制：rAF + 累计时间驱动；帧图 onerror 自动重拉一次（blob URL 被回收）；缩略图兜底双重校验（比例 ±2% 且放大 ≤2.5 倍）；`autoLoad=false` 供详情页只显示首帧预览。

---

## 11. 下载与保存体系

### 11.1 [downloadMonitor.js](../src/utils/downloadMonitor.js) — 下载任务模型

框架无关单例：`jobs: Map<key, job>` + `queueTotal`（多图批量 = 全部页数）；快照供 useSyncExternalStore。

```
job = { key, illustId, page, title, kind: 'image'|'gif',
        status: 'downloading'|'writing'|'done'|'error',
        progress, message, error, retry? }
```

- `start(key, meta)` → 句柄 `{ recordFailure(retryMeta), setProgress(pct, bytes), setStatus, finish(ok) }`
- 进度**只增不减**；bytes 通道算速度（指数平滑 0.65/0.35）——只有原生/桌面流式通道给真实字节
- **失败任务跨会话持久化**（appStorage `downloadFailed`），带 retry 信息供一键重试；完成保留 8s 自动删

### 11.2 平台下载差异

| | nativeDownload.js（Android） | desktopDownload.js（Electron） |
|---|---|---|
| 通道 | Capacitor 插件 `StreamingDownload`（原生 HttpURLConnection） | IPC `download:image`（主进程 Node https） |
| 目的 | 绕 WebView CORS，实时字节进度 | 绕渲染进程 CORS，走 Clash，真实进度 |
| 返回 | base64 | `{id, size, data(base64)}` |

### 11.3 保存链路总览

```
UI 动作
  ├─ 网格长按 ♥ / 详情长按  → saveAllPages（多页）/ saveSingleItem（booru 单条）
  ├─ 详情长按单页           → downloadPage（先补拉详情拿完整日期路径 URL）
  └─ 全部收敛到 saveItem ──→ storageFacade.saveFromNetwork ──→ storageService 内分流（动图 / 静图）
```

---

## 12. 工具层（src/utils）

| 文件 | 职责 |
|---|---|
| **platform.js** | **所有平台判断收口**：`isDesktopShell()` / `getDesktopProxyPort()` / `getGallerySaver()`；不许散落 window 判断 |
| **downloadMonitor.js** | 下载任务模型（§11.1） |
| **nativeDownload.js / desktopDownload.js** | 平台下载通道（§11.2） |
| **backHandler.js** | 系统返回键注册表（Set 逆序执行、500ms 防重） |
| **toast.js** | `showToast` dispatch `pixiv:toast` CustomEvent |
| **proxyCheck.js** | `checkProxyReachable`（探针打首页不打 ajax——无 Cookie 时 ajax 恒 400） |
| **worksState.js** | 复合键反解 illustId（`lastIndexOf('_')` + 纯数字页码校验，对跨来源 id 成立） |
| **appStorage.js** | localStorage 单 key `pixiv_viewer_app` 命名空间存取（内存 cache + 惰性 load） |
| **rankingModes.js** | Pixiv 8 档 / booru 3 档；R18_CATEGORIES；`nextRankingSelection` 联动规则 |
| **meTabs.js** | Me 子 tab 定义；`caps.accountTabs === false`（booru）过滤到只剩 liked |
| **loadedImages.js** | 会话级 URL→已加载登记表（支撑详情页 reuseHd：原图加载过不再拉 master1200） |
| **imageUrl.js** | `masonryThumbUrl`（pixiv 540 档 `c/540x540_70/` 前缀；更大只能去掉 c/ 前缀） |
| **scroll.js** | 滚动容器选择器收口 + 恢复（校准期间检测用户触摸立即停） |
| **hiddenWorks.js** | 「不想看」集合：IndexedDB `_meta_hidden_works`（随主库备份）+ 旧 localStorage 迁移 |
| **logger.js** | 命名空间日志（dev 全级别 / prod 仅 warn+） |
| **desktopFs.js** | 桌面 FS 适配器（**历史遗留：依赖的桥从未实现，无消费方，保留参考**） |
| **likeMeta.js** | `buildLikeMeta(img)` 喜欢所需展示元数据 |

---

## 13. 关键数据模型

### 13.1 统一图片条目（网格/详情/灯箱通用，四家图源对齐）

```
illustId（qualifyId 产物）, source, title,
author / authorName / authorAccount / authorId / authorAvatar,
thumbnailUrl / mediumUrl / originalUrl,
tags, pixivUrl（非 pixiv 恒空）, webUrl,
pageCount, type: 'image'|'gif', illustType, width, height,
rating, score, _pageIndex
```

`authorId` 恒空串 → 关注按钮与作者页自然隐藏（均以 authorId 为守卫）。

### 13.2 IndexedDB 结构（共 2 个库）

| 库 | 版本 | 仓库 | keyPath | 索引 |
|---|---|---|---|---|
| `teyvat_pixiv_cache_v2` | 1 | `metadata` | `cacheKey` | illustId / state / stateCachedAt（复合）/ likedAt / tags（multiEntry）/ cachedAt / author |
| `teyvat_pixiv_tabs` | 3 | `tabs` | `key` | 无（记录 {key, data, updatedAt}，TTL 24h） |

### 13.3 存储三层分工

| 层 | 内容 | 说明 |
|---|---|---|
| IndexedDB（cacheDB） | 元数据 | 查询/分页/统计 |
| 应用私有目录 `DATA/PixivViewer` | cached 态文件 | WebView 私有，卸载即清 |
| 系统相册 MediaStore | saved 态**唯一副本** | 不写私有副本（避免双写）；跨卸载保留 |

---

## 14. 典型数据流

### 14.1 浏览推荐流

```
点 tab → visitedTabs.add → setTab('discover')
→ DiscoverPage 首挂 → loadTabCache（24h TTL）
  ├─ 命中 → 水合恢复游标 + 过滤 → 直接渲染
  └─ 未命中 → fetchDiscovery({limit, start})
       → transport（dev代理/desktop代理/CapacitorHttp）→ Pixiv
       → mapIllustItem → 过滤（seen/hidden/启动前已收藏）→ setItems
       → saveTabCache 持久化
触底 → IntersectionObserver（200px 预载）→ load(true) 续拉
```

### 14.2 保存一张图

```
长按 ♥ → useGridLikeToggle → 乐观更新 → storageFacade.toggleLike
  → repository.toggleLike（轻记录）→ scheduleMetaBackup
  → 喜欢=下载：saveAllPages → 逐页 saveItem
       → storageFacade.saveFromNetwork（并发去重）
            → buildDownloadUrls → networkStore.downloadImage（降级链）
            → fileStore.save（exportToGallery → MediaStore）
            → repository.save（IndexedDB）→ scheduleMetaBackup
```

### 14.3 详情页浏览

```
点图 → openDetail → DetailView（stackRef = [initialImage]）
→ ImageDetailView → fetchIllust（LRU 缓存）→ DetailPageBlock × pageCount
→ 进入视口 → 懒加载原图（本地优先）+ 元数据回填
→ 点大图 → MediaLightbox（手势引擎 / 候选链降级）
→ 点相关推荐 → handleSelect 压栈（栈支持返回）
```

---

## 15. 平台壳：Android / Electron / Web

### 15.1 Android（android/）

**MainActivity.java**（`com.pixivviewer.app`，继承 BridgeActivity）：

- 仅 debug 构建开启 `WebView.setWebContentsDebuggingEnabled`
- 注册 2 个自定义 Capacitor 插件：**GallerySaverPlugin**（MediaStore 写相册）、**StreamingDownloadPlugin**（原生流式下载）
- 关闭滚动条占位

**AndroidManifest.xml 权限**：

| 权限 | 说明 |
|---|---|
| `INTERNET` | 网络 |
| `WRITE_EXTERNAL_STORAGE`（maxSdk=28） | 仅 Android ≤10 写相册 |
| `READ_MEDIA_IMAGES` + `READ_EXTERNAL_STORAGE`（maxSdk=32） | 读相册（启动时 `ensureGalleryReadPermission()` 提前申请） |

MainActivity `launchMode="singleTask"`、全量 configChanges（旋转不重建）。

### 15.2 Electron（electron/）

**main.cjs**：

- **内嵌代理服务**：动态 import scripts/ 三模块，与 Vite dev **同一份中间件** + `withCors` 包装（renderer 以 file:// 加载，跨源必须见 ACAO）；端口默认 51380，占用 +1 重试
- **IPC 通道**：

| 通道 | 方向 | 职责 |
|---|---|---|
| `proxy:get-port` | invoke | 返回代理端口 |
| `download:image` / `download:progress` | invoke / push | 主进程 Node 流式下载 + 真实进度（30s 停滞超时、连接级失败换 Agent 重试） |
| `dialog:save-file` | invoke | 系统保存对话框 / 直接落盘（同名自动 `图 (2).jpg`） |
| `dialog:choose-directory` | invoke | 选保存目录 |

- **webRequest 拦截**：`i.pximg.net` 补 pixiv Referer；`cdn.donmai.us` 整域改道壳内代理（CF 按 TLS 指纹拦截，Node 通道实测 200）
- 安全配置：`contextIsolation: true / nodeIntegration: false / sandbox: true`

**preload.cjs**：两个极小桥 `window.desktopProxy`（getPort / saveFile / chooseDirectory）+ `window.desktop`（download）。

**electron-builder.yml**：win 双 target（nsis + portable）→ `release/`；关闭自动更新。

### 15.3 传输模式差异总表

| 维度 | dev（Vite） | desktop（Electron） | prod（Capacitor Android） |
|---|---|---|---|
| API 通道 | `/pixiv-api` 同源代理 | `127.0.0.1:{port}` 壳内代理 | CapacitorHttp（降级 fetch） |
| Cookie | `x-pixiv-cookie` 头 | 同左 | 直设 Cookie 头 |
| UA/Referer | 代理侧设置 | 代理侧设置 | 显式注入 |
| Ugoira ZIP | `/pixiv-zip` 代理 + fflate 整包解帧 | 同 dev | 流式主路径（直连 i.pixiv.re + fflate） |
| 图片下载 | 图床代理前缀 | 直链 | 直链（原生 StreamingDownload 绕 CORS） |

---

## 16. 开发代理中间件（scripts/）

注册于 `vite.config.js` 的 `configureServer`；**同一份路由表被 Vite dev 与 Electron 壳复用**。

### proxy-utils.mjs（公共底座）

- `getProxyUrl()`：`VITE_PROXY_URL || PROXY_URL || http://127.0.0.1:7890`
- `createAgentHolder()`：可重置 HttpsProxyAgent 容器（长复用被关空闲隧道导致间歇 502，出错 reset 换新）
- `createApiProxy()`：**`x-pixiv-cookie` → Cookie 还原**；透传 `x-csrf-token`；仅幂等请求（GET）自动重试（POST body 已被 pipe 消费）
- `createImageProxy()`：图片转发，可覆写 Cache-Control（7 天）与 UA

### 路由表

| 前缀 | 目标 | 说明 |
|---|---|---|
| `/pixiv-api` | www.pixiv.net | API 代理 |
| `/pixiv-img` | i.pixiv.re / pixiv.re | 短链跟随重定向（**仅白名单域**，防开放代理） |
| `/pixiv-thumb` | i.pixiv.re | 7 天缓存 |
| `/pixiv-zip` | 白名单校验后的 https 目标 | 防本机任意网页借它当开放代理 |
| `/yande-*` `/konachan*` `/safebooru-*` | 各站点 api/img | — |
| `/danbooru-api/-img` `/wallhaven-*` | 各站点 | **API_CLIENT_UA**（CF 拒浏览器 UA + 非 TLS 指纹组合） |

---

## 17. 依赖关系总览

```
App.jsx
  ├─► pages/*.jsx ──► useTabFeed（骨架）
  │      ├─► api/pixiv.js（pixivApi）──► createPixivApi(transport)
  │      │        └─► pixiv-assistant/core/pixiv/*（纯逻辑）
  │      ├─► sources/api.js（booruApiFor）──► 4 协议适配器
  │      │        └─► api/transport.js（与 pixiv 共用！）
  │      └─► storageFacade ──► storageService
  │
  ├─► DetailView ─► ImageDetailView ─► DetailPageBlock
  │      └─► MediaLightbox ─► useTouchGesture / FrameAnimPlayer ─► api/ugoira/index.js
  │
  ├─► useAppStore（zustand）/ PixivCacheProvider（Context×2）
  │
  └─► utils/（platform 收口 / downloadMonitor / backHandler / toast / …）

pixiv-assistant/capacitor/（存储层）
  ├─ storageFacade ─► storageService
  │     ├─► repository ─► cacheDB（IndexedDB）◄─ entity（PixivEntity）
  │     ├─► fileStore ─► config.getFS + gallery.js
  │     ├─► networkStore ─► utils/nativeDownload + desktopDownload
  │     └─► metaBackup ─► cacheDB + hiddenWorks
  ├─ tabCache（独立 IndexedDB 库）
  └─ config ─► utils/appStorage

scripts/（代理中间件）◄─ vite.config.js + electron/main.cjs 双消费
```

**第三方依赖**（package.json）：

| 依赖 | 用途 |
|---|---|
| react / react-dom / react-router-dom | UI 框架 |
| zustand | 全局状态 |
| @capacitor/app / filesystem / status-bar | 原生能力 |
| fflate | ZIP 流式解压（Ugoira） |
| jszip | ZIP 缓冲解压（降级路径） |
| gifenc | GIF 编码（动态 import，不用不进主包） |
| https-proxy-agent | 代理中间件（Node 侧） |

---

## 18. 构建与运行

### 18.1 Web 开发

```bash
npm install
npm run dev          # http://localhost:5182（host 0.0.0.0、strictPort）
```

API 走 Vite 代理，需要本地 HTTP 代理（默认 `http://127.0.0.1:7890`，可在设置改或 `PROXY_URL` 环境变量）。推荐/收藏等需 Cookie：登录 pixiv.net 复制 PHPSESSID，在应用「我」页 ⚙️ 设置里填入（存 localStorage）。

### 18.2 Android（Capacitor）

```bash
npm run build
npx cap sync android
npx cap run android                        # 需 SDK + 设备

# 独立 APK（默认，本地 dist assets，无需 dev server）
npx cap sync android && cd android && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk

# 开发模式（WebView 加载局域网 dev server）
CAP_DEV=1  # capacitor.config.ts 的 server.url 指向 http://192.168.1.4:5182
```

### 18.3 Electron 桌面

```bash
npm run desktop        # 构建 + 启动（需本地 Clash 7890 + 设置页填 Cookie）
npm run desktop:dev    # 桌面壳 + Vite dev server（另开终端 npm run dev）
npm run desktop:build  # Windows 安装包/便携版 → release/
```

### 18.4 环境变量

| 变量 | 说明 |
|---|---|
| `PROXY_URL` / `VITE_PROXY_URL` | 代理地址（默认 `http://127.0.0.1:7890`） |
| `CAP_DEV=1` | Capacitor 开发模式（dev server URL） |
| `CAP_DEV_URL` | 自定义 dev server 地址 |
| `VITE_PIXIV_COOKIE` / `VITE_DEV_COOKIE` | ⚠️ 测试期临时 Cookie 注入，**发版前必须删掉 .env 及 config.js 的 buildCookie** |

> 正式版不需要 .env 文件。`VITE_*` 变量会被静态内联进前端产物（反编译即可读到 PHPSESSID），Cookie 只在设置页手填。

### 18.5 其他脚本

```bash
npm run lint                      # oxlint
node scripts/check-sources.mjs    # 断言 KNOWN_SOURCES 与 registry 一致性
```

---

## 19. 开发规范与已知注意事项

### 19.1 CSS 规范（AGENTS.md）

- **不要使用 `-webkit-backdrop-filter`**：部分安卓 WebView 上会导致标准属性失效，只写 `backdrop-filter`
- `build.cssTarget: 'chrome110'` 的原因同上（Vite 8 默认 esbuild 基线会给 backdrop-filter 加 -webkit- 前缀）
- 毛玻璃通用样式：`.frosted` / `.frosted-light` / `.glass-icon-btn`（定义在 src/index.css）
- CSS 变量：`--bg` / `--bg-panel` / `--border` / `--text-primary` / `--accent` 等定义在 src/index.css

### 19.2 架构守则

- **平台判断收口在 utils/platform.js**，不许散落 `window.Capacitor` / `window.desktopProxy` 判断
- **UI 分支只问 `capsOf(sourceId)`**，禁止 `source === 'pixiv'` 散落判断
- **保存收敛到 saveItem 单一入口**，动图/静图分流只在 `storageService.saveFromNetwork` 一处
- **core 层不反向依赖 UI 层**（日志由 transport 注入）
- **await 之后先验 stale 再推进游标**（过期响应防御体系）
- **appendError 收哨兵**：翻页失败不置 hasMore=false，收哨兵 + 「点击重试」（避免重试风暴）

### 19.3 已知问题 / 待办

| 问题 | 说明 |
|---|---|
| ranking 模式表不一致 | `ranking.js` 的 VALID_MODES（12 项）比 `constants.js` 的 RANKING_MODES（13 项）少 `monthly_r18`，传 `monthly_r18` 会静默回退 `daily` |
| 三处影子副本需人工同步 | booru-proxy 路由表 / KNOWN_SOURCES（check-sources.mjs 守护）；getCookie 双实现已收敛到 `getPixivCookie` |
| ~~动图/静图保存分流~~ | ✅ 已收敛：`api/gif.js` 拆为 `api/ugoira/` 七模块（只管「看」），保存链路并入 `storageService`，动图/静图在 `saveFromNetwork` 入口分流；JSZip 依赖已移除 |
| 灯箱 Esc 未入栈 | useTouchGesture 自实现 Esc，灯箱开着按 Esc 会连灯箱带下面一层一起关 |
| cacheDB 未接线能力 | searchByTag 与 author/cachedAt 索引已建未用 |
| desktopFs.js | 依赖的桥从未实现，无消费方，保留参考 |
| buildCookie 测试期注入 | 发版前必须删除（capacitor/config.js 顶部） |

### 19.4 值得了解的行为语义

1. **幂等是「实际探测」而非「只信状态位」**：`_promoteToSaved` 用 `galleryHasFile` 验证相册文件存在；保存前也先探测相册，命中跳过下载。
2. **轻记录体系**：喜欢未下载作品立即建无 fileName 轻记录，保存时重建保留 likedAt。
3. **进度只增不减**：downloadMonitor 与 ugoira 的多路进度合并都遵守。
4. **「宁可不说，不给假数」**：CapacitorHttp 降级路径拿不到真实字节就不显示速度，不用估算假百分比。
5. **推荐流排除集**：启动时快照，会话中新增收藏保留在当前网格，下次启动才剔除。
6. **图片加载竞态补查**：GridItem / DetailPageBlock 都有 `img.complete` 手动补查（React 托管 img 丢失 onLoad 的挂载期问题，实测 60 项里 29 项会卡在 opacity:0）。

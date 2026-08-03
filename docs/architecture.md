# PixivViewer 代码分层架构

> 本文档基于当前代码分析项目的分层逻辑与架构设计。

---

## 一、整体分层概览

```
┌─────────────────────────────────────────────────┐
│                  Presentation Layer              │
│   App.jsx / Pages / Components / Hooks / Styles  │
├─────────────────────────────────────────────────┤
│                  API Layer                       │
│   api/pixiv.js (传输适配)                         │
│   api/gif.js (动图下载)                           │
│   api/index.js (window.api 兼容层)                │
├─────────────────────────────────────────────────┤
│               Business Logic Layer                │
│   pixiv-assistant/core/                          │
│   ├─ pixivApi.js  (API 工厂，纯逻辑)               │
│   ├─ utils.js     (URL 工具，纯函数)               │
│   └─ constants.js (常量)                          │
├─────────────────────────────────────────────────┤
│               Storage Layer                       │
│   pixiv-assistant/capacitor/                     │
│   ├─ storageFacade.js    (UI 门面)                │
│   ├─ storageService.js   (业务编排)                │
│   ├─ transitionEngine.js (状态机 + Saga 补偿)      │
│   ├─ repository.js       (对象映射)                │
│   ├─ cacheDB.js          (IndexedDB 操作)          │
│   ├─ fileStore.js        (文件操作)                │
│   ├─ networkStore.js     (网络下载)                │
│   ├─ entity.js           (统一数据模型)             │
│   ├─ config.js           (配置管理)                │
│   └─ tabCache.js         (Tab 结果缓存)            │
├─────────────────────────────────────────────────┤
│               Utility Layer                       │
│   utils/ (backHandler / toast / logger / quality)  │
├─────────────────────────────────────────────────┤
│               Server Layer (Dev Only)             │
│   scripts/ (Vite 代理中间件)                       │
└─────────────────────────────────────────────────┘
```

---

## 二、各层详解

### 2.1 表现层（Presentation Layer）

**职责**：UI 渲染、用户交互、页面状态管理。

#### 组件树

```
App.jsx
├─ PullToRefresh        (下拉刷新)
├─ <main>.app-content
│  ├─ [discover] DiscoverPage
│  ├─ [ranking]  RankingPage
│  ├─ [bookmarks] BookmarksPage
│  ├─ [search]   SearchPage
│  └─ [gallery]  GalleryPage
├─ TabBar               (底部导航)
├─ SettingsModal        (设置弹窗)
├─ DetailView           (详情页)
│  └─ ImageDetailView   (大图+信息+推荐)
│     ├─ DetailPageBlock (单页块，懒加载)
│     ├─ UgoiraPlayer    (动图播放器)
│     └─ MediaLightbox   (全屏灯箱)
└─ ToastHost            (Toast 渲染)
```

#### 状态管理

| 状态 | 位置 | 说明 |
|------|------|------|
| `tab` | App | 当前 Tab |
| `pixivCache` | App | 全量缓存状态 `{ [compositeKey]: { cached, saved, liked } }` |
| `likedSet` | App (useMemo) | 从 pixivCache 派生的喜欢 Set |
| `savedSet` | App (useMemo) | 从 pixivCache 派生的已保存 Set |
| `tabTokens` | App | 强制刷新令牌 |
| `visitedTabs` | App (ref) | 已访问 Tab 记录 |
| `scrollPositions` | App (ref) | 各 Tab 滚动位置 |
| `detailImage` | App | 当前详情页作品 |
| `searchSeed` | App | 外部触发搜索的种子 |
| `refreshFnsRef` | App (ref) | 各 Tab 注册的下拉刷新函数 |
| 页面级数据 | 各 Page | items/loading/error/hasMore 等 |

#### 设计决策

- **Tab 懒挂载**：`visitedTabs` 记录已访问 Tab，切换到新 Tab 时挂载，切回不卸载
- **`display: none` 隐藏非当前 Tab**：保持 DOM 状态，切回时滚动位置保留
- **Props 穿透**：`likedSet`/`savedSet`/`onOpen` 等从 App 穿透到各 Page
- **下拉刷新**：通过 `registerRefresh` 回调注册，App 统一分派

---

### 2.2 API 层

**职责**：封装 Pixiv API 的 HTTP 传输，屏蔽平台差异。

#### 架构

```
api/
├── pixiv.js      ← 传输适配层（dev fetch / prod CapacitorHttp）
├── gif.js        ← 动图下载链路（ZIP → 解帧 → GIF 编码）
└── index.js      ← window.api 兼容层（组装上层）
       │
       ▼
pixiv-assistant/core/pixivApi.js  ← API 工厂（纯逻辑，无平台依赖）
```

#### 传输适配（pixiv.js）

```
┌──────────────────────────────────────────────┐
│  pixiv.js                                     │
│                                                │
│  IS_DEV ? devFetch : prodFetch                │
│                                                │
│  devFetch()                                    │
│    → fetch('/pixiv-api/...')                   │
│    → Vite 代理 → Clash → Pixiv                │
│    Cookie 头 → x-pixiv-cookie（浏览器限制）     │
│                                                │
│  prodFetch()                                   │
│    → CapacitorHttp.request()                   │
│    → 失败降级 → fetch() 直连（WIFI 绕过代理）   │
│    Cookie 头 → 直接设置（Capacitor 支持）       │
└──────────────────────────────────────────────┘
```

#### 动图下载（gif.js）

```
fetchUgoiraFrames(illustId, onProgress)
  → /ajax/illust/{id}/ugoira_meta（取元数据）
  → /pixiv-zip/（代理下载 ZIP）
  → JSZip 解压 → 每帧生成 blob URL
  → return { frames: [{ path, delay }], meta }

saveGifToAlbum(item, onProgress)
  → fetchUgoiraFrames（取帧）
  → Canvas 逐帧取像素数据
  → gifenc 编码（共享调色板）
  → 写文件 + 元数据到 IndexedDB
```

---

### 2.3 业务逻辑层（pixiv-assistant/core）

**职责**：纯函数、无平台依赖、可复用于 Web/Electron/Capacitor。

```
core/
├── pixivApi.js    ← API 工厂，接收 Transport 接口
│                    createPixivApi({ fetch, getCookie })
│                    → searchPixiv / fetchIllust / fetchRanking / ...
│                    → 包含 LRU 缓存（5 分钟 TTL）
│                    → 统一数据映射（mapIllustItem / mapRankingItem）
│                    → 错误分类（classifyError）
│
├── utils.js       ← 纯函数工具集
│                    pixivReUrl / proxyThumb / pixivPageUrl
│                    pixivOriginalUrl / extractUserIdFromCookie
│                    getCompositeKey / safeFileName
│                    parseCacheFileName / getCacheKey
│
└── constants.js   ← 常量
                     PIXIV_BASE / PIXIV_RE / RANKING_MODES / ...
```

#### Transport 接口

```typescript
interface Transport {
  fetch(pathname: string, opts?: {
    headers?: Record<string, string>,
    timeout?: number,
    skipCookie?: boolean,
  }): Promise<object>;

  getCookie(): Promise<string>;
}
```

**设计要点**：
- `createPixivApi` 是工厂函数，接收 Transport 接口实现
- 所有 API 函数只写一次，平台差异只影响 Transport 层
- 内置 LRU 缓存（50 条，5 分钟 TTL），避免重复请求
- 统一数据映射，兼容 camelCase 和 snake_case
- 错误分类返回中文友好提示

---

### 2.4 存储层（pixiv-assistant/capacitor）

**职责**：图片文件的下载、存储、状态管理、元数据持久化。

#### 分层架构

```
┌──────────────────────────────────────────────────────────┐
│  StorageFacade (UI 门面)                                  │
│  职责：参数校验、错误转换、Toast 提示                      │
│  特点：单例，并发去重（_saveInFlight Map）                  │
├──────────────────────────────────────────────────────────┤
│  PixivStorageService (业务编排层)                          │
│  职责：业务规则编排，不执行具体操作                        │
│  save → TransitionEngine → cached→saved                   │
│  saveFromNetwork → NetworkStore + FileStore + Repository  │
├──────────────────────────────────────────────────────────┤
│  TransitionEngine (状态迁移引擎)                           │
│  职责：Saga 补偿模式，三步策略 + 倒序回滚                  │
│  1. copy_file → 2. update_meta → 3. cleanup               │
├─────────────────────┬────────────────────────────────────┤
│  PixivRepository    │  FileStore                          │
│  (对象映射)          │  (文件操作)                          │
│  Entity ↔ IndexedDB │  路径规则 + 读写 + 复制 + 删除       │
├─────────────────────┴────────────────────────────────────┤
│  cacheDB.js (IndexedDB)  │  NetworkStore (网络下载)        │
│  元数据 CRUD + 索引查询   │  fetch / CapacitorHttp / XHR   │
│  分页 + 统计 + 迁移      │  ZIP 下载 + 进度回调            │
├──────────────────────────┴────────────────────────────────┤
│  PixivEntity (统一数据模型)                                │
│  id: 'pixiv:{illustId}:{pageIndex}'                       │
│  state: 'cached' | 'saved'                                │
│  type: 'image' | 'gif'                                    │
└──────────────────────────────────────────────────────────┘
```

#### 数据模型

```javascript
PixivEntity {
  id:        'pixiv:12345678:0',  // 统一 key
  illustId:  '12345678',
  pageIndex: 0,
  type:      'image' | 'gif',
  state:     'cached' | 'saved',
  flags:     { favorite, syncing, ... },
  fileName:  'pixiv_12345678_p0_[Author]_[Title].jpg',
  title, author, authorName, authorAccount, authorId,
  tags, cachedAt, size, frames, frameCount,
  pixivUrl, originalUrl, thumbnailUrl, mediumUrl,
  likedAt,
}
```

#### 状态迁移

```
cached ←→ saved  (TransitionEngine + Saga 补偿)
  ↓                    ↑
  └── 下载 + 写入 ─────┘  (saveFromNetwork)

delete = 删除 file + 删除 meta（无 deleted 状态）
```

---

### 2.5 工具层（utils）

| 文件 | 职责 |
|------|------|
| `backHandler.js` | 系统返回键处理器注册表（后进先出） |
| `toast.js` | CustomEvent 广播 Toast |
| `logger.js` | 带前缀的日志工具（dev 输出、prod 静默） |
| `quality.js` | 画质档位切换（thumb/mini/original/regular） |

---

### 2.6 服务层（scripts）

**职责**：Vite dev server 中间件，通过 Clash 代理转发 Pixiv 请求。

```
scripts/
├── proxy-utils.mjs   ← 通用代理工具
│   createApiProxy()    → API 请求代理
│   createImageProxy()  → 图片请求代理
│   createAgentHolder() → 可重置的 Agent 容器
│   checkProxyAvailability() → 代理可用性检查
│
└── pixiv-proxy.mjs    ← Pixiv 专用代理
    registerPixivProxies()
    → /pixiv-api    → www.pixiv.net
    → /pixiv-img    → i.pixiv.re / pixiv.re
    → /pixiv-thumb  → i.pixiv.re
    → /pixiv-zip    → 原始 ZIP（Ugoira）
```

---

## 三、数据流

### 3.1 浏览图片流程

```
用户操作            → 点击 Tab（如"排行"）
                     │
App.handleTabChange  → visitedTabs.add('ranking')
                     → setTab('ranking')
                     │
RankingPage          → mount（首次挂载）
                     → loadTabCache('ranking')  ← 尝试恢复缓存
                     → 缓存命中？跳过加载：调用 API
                     │
pixivApi.fetchRanking → createPixivApi
                     → transport.fetch()  ← devFetch / prodFetch
                     → Vite 代理 / CapacitorHttp → Pixiv
                     │
返回数据             → mapRankingItem（统一映射）
                     → setItems → 渲染 ImageGrid
                     → saveTabCache（持久化缓存）
```

### 3.2 保存图片流程

```
用户点击"喜欢"       → LikeButton.handleLike
                     │
optimistic update    → 立即更新 pixivCache（UI 即时反馈）
                     │
storageFacade.toggleLike → PixivStorageService.toggleLike
                         → PixivRepository.toggleLike
                         → cacheDB.putMeta（IndexedDB）
                     │
if liked → onLikeSaveAll → saveAllPages
  → 遍历每页
  → storageFacade.saveFromNetwork(item)
    → PixivStorageService.saveFromNetwork
      → buildDownloadUrls（候选 URL 列表）
      → NetworkStore.downloadImage（fetch → CapacitorHttp 降级）
      → FileStore.save（写文件）
      → PixivRepository.save（写元数据）
```

### 3.3 详情页浏览流程

```
用户点击图片         → ImageGrid → App.openDetail → setDetailImage
                     │
DetailView           → mount → 初始化栈（stackRef = [initialImage]）
                     │
ImageDetailView      → fetchIllust（取详情数据）
                     → render DetailPageBlock × pageCount
                     │
DetailPageBlock      → IntersectionObserver 进入视口
                     → savePage（自动保存，静默）
                     → loadOriginal（本地优先 → 网络原图）
                     → 缩略图模糊铺底 → 原图就绪后替换
                     │
用户点击大图         → setLightboxIndex → MediaLightbox
                     → 全屏灯箱，支持缩放/滑动/翻页
                     │
用户点击相关推荐     → handleSelect（压栈）
                     → setImage（切换作品）
                     → 详情栈支持返回
```

---

## 四、分层评价

### 4.1 正向设计

| 设计 | 评价 |
|------|------|
| **API 工厂模式** | `createPixivApi(transport)` 完美隔离平台差异，API 逻辑只写一次 |
| **Saga 补偿模式** | `TransitionEngine` 的状态迁移三步策略 + 倒序回滚 → 数据一致性有保障 |
| **统一数据模型** | `PixivEntity` 作为全系统唯一数据契约，各层不直接操作原始 DB 记录 |
| **Transport 接口** | 薄接口定义清晰，dev/prod 切换只需换一个实现 |
| **幂等设计** | save/unsave/toggleLike 全部幂等，避免重复操作 |
| **并发去重** | `_saveInFlight` 自动保存 + 手动保存共享同一个 Promise |
| **乐观更新** | 喜欢/保存先更新 UI，再异步确认，体验流畅 |
| **代理故障恢复** | `createAgentHolder` 支持重置，连接失败自动重试 |

### 4.2 可改进点

| 问题 | 说明 |
|------|------|
| **StorageFacade 混入 Toast** | UI 门面层不应该直接依赖 Toast，应抛错误让 UI 层 catch |
| **pixivCache 扁平状态** | 大对象 + setState 穿透多层 → 级联重渲染 |
| **window.api 全局对象** | 不利于类型检查和测试 mock |
| **动图/静图保存分流** | `saveFromNetwork` 返回 `gif_not_supported`，调用方再转 `saveGifToAlbum`，流程不够内聚 |
| **FileStore cached/saved 同目录** | `_resolveDir` 对 cached 和 saved 返回同一路径，状态分离失去物理意义 |
| **Tab 页面重复模式** | 缓存水合、无限滚动、刷新令牌在 4 个页面中重复实现 |
| **GifPlayer/UgoiraPlayer 重复** | 两个组件几乎相同，应合并 |

---

## 五、架构图：模块依赖关系

```
App.jsx
  ├─ ► pages/*.jsx ────────────────────────────────┐
  │    ├─ pixivApi (via api/pixiv.js)               │
  │    │    └─ createPixivApi(transport)            │
  │    │         └─ pixiv-assistant/core/pixivApi.js│
  │    ├─ storageFacade                             │
  │    │    └─ pixiv-assistant/capacitor/storageFacade│
  │    └─ tabCache (via pixiv-assistant/index.js)    │
  │                                                  │
  ├─ ► DetailView ── ImageDetailView ────────────────│
  │    ├─ pixivApi.fetchIllust                       │
  │    ├─ storageFacade.saveFromNetwork              │
  │    └─ MediaLightbox ── GifPlayer / UgoiraPlayer  │
  │                                                  │
  ├─ ► utils/ (backHandler, toast, logger, quality)  │
  │                                                  │
  └─ ► pixiv-assistant/ (核心存储层) ────────────────┘
       │
       ├─ core/pixivApi.js   ← 纯逻辑，无平台依赖
       ├─ core/utils.js      ← 纯函数
       │
       └─ capacitor/         ← 平台依赖（IndexedDB + Filesystem）
            ├─ storageFacade.js ← 依赖 showToast (utils/)
            ├─ storageService.js ← 依赖 NetworkStore + FileStore + Repository
            ├─ transitionEngine.js ← 依赖 Repository + FileStore
            ├─ repository.js   ← 依赖 cacheDB.js
            ├─ cacheDB.js      ← 依赖 IndexedDB
            ├─ fileStore.js    ← 依赖 Capacitor Filesystem
            ├─ networkStore.js ← 依赖 fetch / CapacitorHttp
            ├─ config.js       ← 依赖 localStorage / Capacitor
            └─ tabCache.js     ← 依赖 IndexedDB
```

---

## 六、总结

当前项目采用**分层架构**，核心设计原则是**核心逻辑与平台解耦**：

1. **core/** 是纯业务逻辑，不依赖任何平台 API，可在任何 JS 环境复用
2. **capacitor/** 封装了所有平台特定实现（IndexedDB、Filesystem、CapacitorHttp）
3. **api/pixiv.js** 通过 Transport 接口桥接 core 和平台
4. **StorageFacade** 作为 UI 门面隔离 UI 和存储层
5. **TransitionEngine** 的 Saga 模式是亮点，保证数据一致性

整体架构清晰，分层合理，主要优化空间在**表现层的代码重复**和**状态管理的性能**上。
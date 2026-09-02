# pixivViewer 代码架构优化报告

> 报告日期：2026-08-04 · 审查范围：69 个源文件 · 综合评分：**72/100**

---

## 目录

1. [总体评估](#1-总体评估)
2. [评分明细](#2-评分明细)
3. [架构亮点](#3-架构亮点)
4. [严重问题（必须修复）](#4-严重问题必须修复)
5. [中度问题（近期应修复）](#5-中度问题近期应修复)
6. [轻度问题（可逐步改进）](#6-轻度问题可逐步改进)
7. [逐模块诊断](#7-逐模块诊断)
8. [CSS 问题汇总](#8-css-问题汇总)
9. [优化路线图](#9-优化路线图)
10. [附录：文件清单与评级](#10-附录文件清单与评级)

---

## 1. 总体评估

pixivViewer 是一个 **React 19 + Vite 8 + Capacitor 8** 的 Android 混合应用，用于浏览和下载 Pixiv 插画。项目在核心技术难点（手势引擎、动画播放、流式处理）上表现出色，但**工程基础设施欠账**（类型系统、格式化、测试、代码重复）拉低了整体质量。

**技术栈：** React 19.2 | Vite 8.2 | Zustand 5.0 | Capacitor 8 | oxlint | IndexedDB | fflate/gifenc

**代码规模：** ~12,000 行 JavaScript/JSX/CSS，分布在 69 个源文件中。

---

## 2. 评分明细

| 维度 | 满分 | 得分 | 等级 | 关键短板 |
|------|------|------|------|----------|
| **目录结构** | 15 | 13 | A | 空 `router/` 目录、barrel 导出重叠 |
| **组件设计** | 15 | 11 | B | 超大组件、零 Props 类型约束 |
| **状态管理** | 10 | 8 | B | `window` 污染、CustomEvent 总线 |
| **CSS/样式架构** | 10 | 6 | C | 743 行全局 CSS、硬编码颜色、魔法 z-index |
| **错误处理** | 10 | 8 | B | 普遍有 try/catch，但防御性边界检查不足 |
| **性能优化** | 10 | 8 | B | memo/惰性渲染/LRU 缓存做得好，偶有 O(n²) |
| **代码规范性** | 10 | 5 | **D** | 无 TS、无 PropTypes、仅 2 条 lint 规则、无 formatter |
| **文档注释** | 5 | 4 | B | 核心模块 JSDoc 优秀，组件层普遍缺失 |
| **可测试性** | 5 | 2 | **D** | 零测试文件，大量模块耦合紧密 |
| **构建/工程化** | 10 | 7 | B | Vite 代理巧妙，但无 CI、自定义插件散落 |
| **总分** | **100** | **72** | **B-** | |

---

## 3. 架构亮点

### 3.1 手势引擎 (`src/hooks/useTouchGesture.js` — 747 行)

```
评分：★★★★★ (5/5)
```

- 单指滑动导航、双指缩放、惯性动画、弹簧回弹、键盘导航一应俱全
- 性能架构正确：直接 DOM 操作 + CSS transition 驱动动画 = 60fps GPU 合成
- 注释非常详尽，解释了为什么要直接操作 DOM 而非走 React 状态
- `rubberBand` / `hardClamp` 阻尼曲线设计合理

### 3.2 Ugoira GIF 管线 (`src/api/gif.js` — 715 行)

```
评分：★★★★★ (5/5)
```

- **双通道架构**：流式解压 (fflate) → 缓冲降级 (JSZip)，自适应不同运行环境
- **LRU 磁盘缓存**：`trimZipCache` 按数量和总字节数双重限制
- **并发去重**：`inflight` Map 防止同一 illustId 重复下载 ZIP
- **内存管理**：blob URL 回收 (`releaseFrames`)、逐帧像素释放
- **停滞检测**：`AbortController` + 进度超时自动中断

### 3.3 存储服务 (`src/pixiv-assistant/capacitor/storageService.js` — 362 行)

```
评分：★★★★½ (4.5/5)
```

- 依赖注入构造函数，各层（Repository、FileStore、TransitionEngine、NetworkStore）可替换
- `buildDownloadUrls` 导出供测试——项目中唯一考虑可测试性的模块
- CRUD API 命名清晰、JSDoc 全面
- 分层合理：Facade → Service → Repository/FileStore/TransitionEngine → CacheDB

### 3.4 下载监听系统

```
评分：★★★★★ (5/5)
```

- `downloadMonitor.js` 实现 `useSyncExternalStore` 协议
- `DownloadMonitor.jsx` 用 `useSyncExternalStore` 订阅——React 18 标准模式
- 零 DOM 开销（空闲时返回 `null`）
- 8 秒自动清理完成的任务

### 3.5 平台自适应 HTTP (`src/api/pixiv.js`)

```
评分：★★★★☆ (4/5)
```

- Dev：Vite 代理（绕过浏览器 CORS）
- Prod：CapacitorHttp（原生 HTTP 栈） → fetch 降级
- 禁用的浏览器限制头 (`cookie`, `referer`) 通过 `x-pixiv-cookie` 传递

---

## 4. 严重问题（必须修复）

### 🔴 CRIT-01：零类型安全

**影响范围：** 所有 JSX 文件（30+ 个组件）

**问题描述：**
TypeScript 7.0.2 已安装但仅用于根目录的 `capacitor.config.ts`。所有应用代码为纯 JavaScript，无 PropTypes、无 JSDoc 类型注解、无 `.d.ts` 类型声明。

**后果：**
- 跨组件 Props 传递全靠约定，重构风险极高
- IDE 无智能提示、无跳转定义
- 运行时 TypeError（如 `undefined is not a function`）无编译时拦截

**修复方案：**
```bash
# 阶段 1：初始化 TypeScript（不强制类型）
npx tsc --init --jsx react-jsx --moduleResolution bundler \
  --target ES2022 --module ESNext --allowJs --checkJs false

# 阶段 2：逐个文件迁移为 .tsx/.ts
# 优先迁移：store、hooks、api、pixiv-assistant/core

# 阶段 3：启用 strict 模式
```

**建议优先级：** P0（建议下一个迭代就启动）

---

### 🔴 CRIT-02：双重状态管理（缓存层）

**影响范围：**
- `src/store/usePixivCacheStore.js`（Zustand store）
- `src/context/PixivCacheProvider.jsx`（React Context）

**问题描述：**
两个模块独立维护相同的 `pixivCache` + `likedSet` 状态，初始化逻辑（扫描 `storageFacade.getAll()`、构建 patch、重算 `likedSet`）完全重复。组件使用其中任意一个都会导致与另一个不同步。

**图示：**
```
storageFacade (IndexedDB)
     ↓                    ↓
PixivCacheProvider    usePixivCacheStore
(React Context)       (Zustand)
     ↓                    ↓
usePixivCache()        usePixivCacheStore()
(部分组件使用)          (其他组件使用)
     ✗ 两个源不同步 ✗
```

**修复方案：**
1. **保留 Zustand store**，删除 `PixivCacheProvider.jsx`
2. 将 Provider 的初始化逻辑迁移到 Zustand store 的 `initCache()` action
3. 修改 `pixivCacheContext.js` 中的 `usePixivCache()` / `useLikedSet()` 为对 Zustand store 的 selector 封装

**建议优先级：** P0

---

### 🔴 CRIT-03：零测试覆盖

**影响范围：** 整个项目

**问题描述：**
69 个源文件，零个测试文件（`.test.js`、`.spec.js`、`__tests__/` 均不存在）。

**后果：**
- 重构时无安全网
- 核心业务逻辑（存储状态机、GIF 编码、API 错误分类）无回归保护
- `storageService.js` 的依赖注入设计完全浪费了

**修复方案：**
```bash
npm install -D vitest @testing-library/react jsdom
```

优先编写以下测试：
1. `storageService.test.js` — save/unsave/delete 状态机（最高 ROI）
2. `pixivApi.test.js` — `classifyError` 和 `mapIllustItem`
3. `utils.test.js` — `parseCacheFileName` 各格式分支
4. `useTouchGesture.test.js` — 缩放/滑动/边界行为

**建议优先级：** P0

---

## 5. 中度问题（近期应修复）

### 🟡 MOD-01：useTabFeed 采用率不足

**问题：** `useTabFeed` 被设计为统一的分页 hook，但以下组件仍手动实现了相同逻辑：

| 组件 | 重复代码行数 | 备注 |
|------|-------------|------|
| `RankingPage.jsx` | ~50 行 | 与 DiscoverPage 逻辑几乎一致 |
| `GalleryPage.jsx` | ~40 行 | 本地数据源，略有差异 |
| `AuthorWorksPage.jsx` | ~45 行 | 作者作品列表 |

**修复方案：**
- 扩展 `useTabFeed` 支持非 Pixiv API 数据源（`fetchPage: () => Promise<{items, hasMore}>`）
- 将 `RankingPage` 迁移到 `useTabFeed`
- 为 `GalleryPage` 提供本地数据适配器

**建议优先级：** P1

---

### 🟡 MOD-02：超级组件需要拆分

| 组件 | 行数 | 职责数 | 建议拆分 |
|------|------|--------|----------|
| `FrameAnimPlayer.jsx` | 548 | 8 | `useFrameCache`、`useFramePlayback`、`useCanvasSizing`、`FrameProgress` |
| `ImageDetailView.jsx` | 421 | 6 | `useIllustData`、`useRelatedWorks`、`PageGrid`、`MetadataSection` |
| `MediaLightbox.jsx` | 396 | 5 | `VideoPlayer` 独立文件、`renderVideoContent` → `videoPlatforms.js` |

**建议优先级：** P1

---

### 🟡 MOD-03：状态通知机制不统一

项目中同时存在 4 种跨组件通信方式：

| 方式 | 使用场景 | 问题 |
|------|---------|------|
| Zustand store 订阅 | Tab、Detail、Search | ✅ 推荐 |
| React Context | PixivCache、LikedSet | 与 Zustand store 重复 |
| `window.dispatchEvent(CustomEvent)` | liked-changed、toast | 无类型、无追踪、脆弱 |
| ref 回调注册 | PullToRefresh | 注册表维护困难 |

**修复方案：**
- 将 `pixiv:liked-changed` 事件替换为 Zustand store 的 `subscribe` 或 selector
- 将 `pixiv:toast` 事件替换为 Zustand toast slice
- 将 `refreshFns` Map 替换为 store 的统一 `triggerRefresh(tab)` action

**建议优先级：** P1

---

### 🟡 MOD-04：直接 DOM 查询破坏封装

| 位置 | 查询目标 | 行号 |
|------|---------|------|
| `useAppStore.js` | `.app-content` | 22, 34, 71, 82 |
| `PullToRefresh.jsx` | `.app-content` | 44 |
| `DetailView.jsx` | `.char-state-content` | 29 |
| `SearchPage.jsx` | `.app` | portal target |

**修复方案：**
- 滚动容器通过 `useRef` 或 Context 传递，不硬编码 CSS 类名
- Portal 目标使用 `document.getElementById('search-bar-root')` 替代 `.app`
- Store actions 接收 `containerRef` 参数而非自行 querySelector

**建议优先级：** P1

---

### 🟡 MOD-05：IndexedDB 迁移债

**问题：**
- `cacheDB.js`：10 个版本的 `onupgradeneeded` 内联迁移（150 行）
- `repository.js`：每次 `find()` 检查 3 种旧 key 格式
- `cacheDB.js` 末尾 IIFE `cleanTitles` 每次 import 都执行全表扫描

**修复方案：**
- 将 `onupgradeneeded` 重构为迁移函数表：`const MIGRATIONS = { 1: migrateV1, 2: migrateV2, ... }`
- 执行一次性的格式迁移（`MIGRATE_TO_V11`），将旧 key 全部转换为新格式
- 将 `cleanTitles` IIFE 改为版本号绑定的单次迁移（如 v11）

**建议优先级：** P2

---

## 6. 轻度问题（可逐步改进）

### 🔵 MIN-01：barrel 导出重叠

- `src/pixiv-assistant/index.js` 和 `src/pixiv-assistant/capacitor/index.js` 导出大量重叠项
- `PixivEntity` 从两个路径都能 import，不确定权威来源
- 建议：`index.js` 只从 `capacitor/index.js` re-export，不重复列出

### 🔵 MIN-02：模块级可变状态

| 模块 | 变量 | 问题 |
|------|------|------|
| `useImagePreloader.js` | `preloaded` Set | 跨热重载/卸载保留 |
| `FrameAnimPlayer.jsx` | `downloadCache` Map | 同上 |
| `fileStore.js` | `ensuredDirs` Set | 同上 |

建议：使用 `useRef` 或 WeakMap 限定生命周期。

### 🔵 MIN-03：魔法数字

| 文件 | 数值 | 含义 |
|------|------|------|
| `index.css` | `z-index: 10000` | lightbox overlay |
| `index.css` | `z-index: 5, 10, 30, 40, 100, 200, 300` | 各层 UI |
| `storageService.js` | `600ms / +4` | 进度模拟 |
| `backHandler.js` | `500ms` | 双击防抖 |
| `ToastHost.jsx` | `2500ms` | toast 持续时长 |
| `DownloadMonitor.jsx` | `8000ms` | 完成自动清理 |

建议：提取为命名常量或 CSS 变量（`--z-tab-bar: 10; --z-modal: 100; --z-lightbox: 10000`）。

### 🔵 MIN-04：lint 覆盖不足

`oxlint` 仅启用 2 条规则，无 ESLint、无 Prettier：

```json
// 当前 .oxlintrc.json
{
  "plugins": ["react", "oxc"],
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": "warn"
  }
}
```

建议扩展：
```json
{
  "rules": {
    "react/rules-of-hooks": "error",
    "react/jsx-no-target-blank": "error",
    "react/no-array-index-key": "warn",
    "oxc/no-unused-vars": "warn",
    "oxc/no-const-assign": "error"
  }
}
```

同时配置 Prettier：
```json
// .prettierrc
{ "semi": true, "singleQuote": true, "tabWidth": 2, "trailingComma": "all" }
```

### 🔵 MIN-05：O(n²) 去重

`ImageDetailView.jsx` 第 367 行：
```js
// ❌ O(n²)
const isDuplicate = related.findIndex(i => i.illustId === id) < idx;
```

修复：
```js
// ✅ O(n)
const seen = new Set();
const deduped = related.filter(i => {
  if (seen.has(i.illustId)) return false;
  seen.add(i.illustId);
  return true;
});
```

### 🔵 MIN-06：eslint-disable 注释

| 文件 | 行号 | 原因 |
|------|------|------|
| `MediaLightbox.jsx` | 128 | iwara quality 仅在 index 变化时重置 |
| `ImageDetailView.jsx` | 113 | 避免无限循环 |
| `FrameAnimPlayer.jsx` | 154, 173, 330, 418 | deps 不稳定 |

建议：用注释解释为什么省略 deps，或重构为更稳定的依赖。

### 🔵 MIN-07：死代码

| 文件 | 内容 | 建议 |
|------|------|------|
| `App.css` | ~185 行 Vite 模板 CSS | 完全删除或清空 |
| `PreviewModal.jsx` | 注释说明是"过渡方案" | 确认后删除 |
| `src/api/index.js` | 历史兼容层 | 合并到调用处，删除文件 |
| `helpers.js` | `affinityLabel` 等未导出函数 | 删除或移到单独模块 |
| `constants.js` | `CACHE_DIR = 'TeyvatWhisper'` | 改为 `pixivViewer` |
| `src/router/` | 空目录 | 删除 |

---

## 7. 逐模块诊断

### 7.1 `src/App.jsx`（168 行）

| 项目 | 评价 |
|------|------|
| 职责 | 路由枢纽——Tab 切换 + Detail overlay + Author overlay + Settings + Toast + PullRefresh |
| 耦合度 | ⚠️ 高：直接导入 9+ 模块，向所有 children 分发 store 值 |
| 错误处理 | ✅ 每 tab 包裹 `<ErrorBoundary>` |
| 反模式 | `window.__pixivViewer` 全局污染；`style={{ display: ... }}` 重复 5 次 |

**建议：** 提取 `<TabContent>` 组件减少重复；用 CSS Module 替代内联 display 控制。

---

### 7.2 `src/components/FrameAnimPlayer.jsx`（548 行）

| 项目 | 评价 |
|------|------|
| 职责 | Canvas 帧动画播放器——加载、播放、预加载、缓存、尺寸计算、进度、错误处理 |
| 耦合度 | ⚠️ 单一组件承担 8 项职责 |
| 反模式 | 模块级 `downloadCache` Map；4 处 eslint-disable；canvas 尺寸计算 10+ 行分支逻辑 |

**建议：** 拆分为 `useFrameCache`、`useFramePlayback`、`useCanvasSizing` 三个 hook。

---

### 7.3 `src/components/detail/ImageDetailView.jsx`（421 行）

| 项目 | 评价 |
|------|------|
| 职责 | 详情页——数据获取、页面网格、相关作品、元数据、lightbox、收藏按钮 |
| 错误处理 | ✅ API 失败有 catch；图片加载失败有占位 UI |
| 反模式 | O(n²) 去重；`setTimeout 100ms` 等待布局；IIFE 每次 render 都重新计算 |

**建议：** `lightboxMedia` 用 `useMemo` 包裹；`saveAllPages` 用 `startTransition` 批处理状态更新。

---

### 7.4 `src/pixiv-assistant/core/pixivApi.js`（521 行）

| 项目 | 评价 |
|------|------|
| 职责 | Pixiv API 工厂——10+ API 方法 + 数据映射 + 错误分类 + LRU 缓存 |
| 错误处理 | ✅ `classifyError` 分类处理 |
| 反模式 | 错误消息使用中文字符串匹配（`'网络错误'`）；LRU delete-then-reinsert 低效 |

**建议：** 按域拆分为 `api/search.js`、`api/discovery.js`、`api/ranking.js` 等子模块。

---

### 7.5 `src/pixiv-assistant/capacitor/cacheDB.js`（591 行）

| 项目 | 评价 |
|------|------|
| 职责 | IndexedDB 抽象——10 版本 schema 迁移 + CRUD + 分页查询 + 统计 |
| 反模式 | 150 行内联 `onupgradeneeded`；模块级 IIFE `cleanTitles` 每次 import 全表扫描；`getCacheStats` 全表游标遍历阻塞事务 |

**建议：** 迁移函数表模式；将 `cleanTitles` 改为 v11 单次迁移；统计用 `IDBObjectStore.count()` 替代全表游标。

---

### 7.6 其余模块快速诊断

| 模块 | 行数 | 评分 | 主要问题 |
|------|------|------|----------|
| `ImageGrid.jsx` | 63 | A | ✅ 清洁的展示组件，memo 优化到位 |
| `TabBar.jsx` | 15 | B | 无 ARIA、无 `role="tablist"` |
| `ErrorBoundary.jsx` | 76 | B+ | 类组件模式正确，但 `errorInfo` 未存 state |
| `ToastHost.jsx` | 24 | C+ | 定时器未清理、固定 duration、`Date.now()` ID 碰撞风险 |
| `SettingsModal.jsx` | 94 | B | read-modify-write 可能丢并发更新、无 cookie 格式验证 |
| `PageHeader.jsx` | 20 | B- | CSS 类名是 chat 遗留（`chat-header-char`） |
| `HeartIcon.jsx` | 33 | A- | SVG 质量好，但 `strokeWidth={0}` 不符 SVG 规范 |
| `SearchIcon.jsx` | 22 | A | ✅ 干净，`aria-hidden` 正确 |
| `DiscoverPage.jsx` | 67 | B+ | `log.warn` 误用为 debug；cookie 检测用脆弱正则 |
| `RankingPage.jsx` | 223 | C+ | 未使用 `useTabFeed`；`refreshToken` 行为误导 |
| `BookmarksPage.jsx` | 57 | B | 未设 `_totalPages`，多页作品可能显示不全 |
| `GalleryPage.jsx` | 103 | C+ | 未使用 `useTabFeed`；`onOpen` 硬编码 page 0 缩略图 |
| `AuthorWorksPage.jsx` | 153 | C+ | 手动重实现无限滚动 |
| `GifPlayer.jsx` | 22 | A | ✅ 干净的委托模式 |
| `UgoiraPlayer.jsx` | 22 | A | ✅ 干净的委托模式 |
| `NeedCookieNotice.jsx` | 9 | A | ✅ 最小化、干净 |
| `useStableCallback.js` | 7 | A | ✅ 正确实现了稳定引用模式 |
| `useImagePreloader.js` | 50 | B+ | 模块级 Set 跨生命周期保留；FIFO 依赖 Set 插入顺序 |
| `helpers.js` | 154 | C | 混合了 Pixiv 工具和 AI 角色系统代码 |
| `entity.js` | 161 | B | 大量旧格式兼容逻辑，应该是一次性迁移 |
| `repository.js` | 194 | B- | 每次 `find` 检查旧 key；`toggleLike` 副作用不直观 |
| `fileStore.js` | 256 | B | `_resolveDir` 忽略 `state` 参数；`_base64ToBuf` 用 fetch 效率低 |
| `transitionEngine.js` | 154 | B | Saga 类过度设计；补偿失败无恢复机制 |
| `storageFacade.js` | 152 | B | 大量平凡透传方法；可合并入 storageService |
| `tabCache.js` | 176 | B | 第二个独立 IndexedDB 数据库；TTL 键匹配脆弱 |
| `gallery.js` | 109 | B+ | 权限结果无缓存；插件不可用时静默失败 |
| `config.js` | 93 | B | cookie 构建时打包；`_fsCache` 永久缓存 |
| `networkStore.js` | 132 | A- | ✅ 多层降级策略；`AbortSignal.timeout` 兼容性需注意 |
| `utils.js` | 229 | B | `parseCacheFileName` 8 种格式分支 = 累积迁移债 |
| `types.js` | 92 | B | 缺少 `PixivEntity` 类型定义 |
| `constants.js` | 37 | C+ | `CACHE_DIR = 'TeyvatWhisper'` 是另一个项目的名字 |
| `logger.js` | 37 | A- | ✅ 简洁，生产环境无持久化 |
| `toast.js` | 15 | B+ | 全局 seq 不重置（理论问题） |
| `backHandler.js` | 24 | B | 500ms 防抖阻止合法快速返回 |
| `performance.js` | 74 | B | `window.__perf` 生产环境也暴露；`withPerf` 不保留 this |
| `quality.js` | 16 | B | 正则替换依赖 Pixiv CDN URL 格式不变 |
| `storageFeedback.js` | 45 | B | `invalid_state:` 错误消息匹配可能丢上下文 |
| `main.jsx` | 29 | B+ | `StatusBar` 调用未 await；全局错误无恢复 |
| `pixiv.js` | 79 | A- | ✅ 平台自适应设计好，但 `x-pixiv-cookie` 未文档化 |

---

## 8. CSS 问题汇总

| 问题 | 严重度 | 位置 |
|------|--------|------|
| `App.css` 100% 死代码（Vite 模板残留） | 🔴 | `App.css` |
| `index.css` 743 行过大 | 🟡 | `index.css` |
| 两个 `:root` 块应合并 | 🔵 | `index.css` 1-12, 15-36 |
| 硬编码颜色代替 CSS 变量 | 🟡 | `search.css` 多处 |
| 魔法 z-index 散落 | 🔵 | 全局 |
| `animation: lightboxIn` 未定义 | 🔵 | `lightbox.css` |
| 多处缩进不一致 | 🔵 | `index.css` 284-303; `lightbox.css` 217-243 |
| `.search-bar--bottom` 矛盾定位 | 🔵 | `search.css` |

---

## 9. 优化路线图

### 第一阶段：止血（预计 3-5 天）

| # | 任务 | 优先级 | 预期效果 |
|---|------|--------|----------|
| 1 | 合并 `PixivCacheProvider` 到 `usePixivCacheStore`，删除重复状态 | P0 | 消除缓存不同步 bug |
| 2 | 删除 `App.css` 全部死代码 | P0 | 清理 185 行无用 CSS |
| 3 | 配置 Prettier + 扩展 oxlint 规则集 | P0 | 统一代码风格 |
| 4 | 将 `window.dispatchEvent` 替换为 Zustand store 事件 | P1 | 统一通信机制 |
| 5 | 删除 `src/router/` 空目录 | P2 | 清理无用结构 |

### 第二阶段：夯实（预计 1-2 周）

| # | 任务 | 优先级 | 预期效果 |
|---|------|--------|----------|
| 6 | 为 store/hooks/api 层添加 TypeScript 类型声明 | P0 | IDE 智能提示 + 编译时检查 |
| 7 | 修复 O(n²) 去重 + eslint-disable 注释 | P1 | 代码质量提升 |
| 8 | `RankingPage`、`GalleryPage` 迁移到 `useTabFeed` | P1 | 消除 ~90 行重复代码 |
| 9 | `FrameAnimPlayer` 拆分为 3 个 hook | P1 | 可维护性提升 |
| 10 | 消除直接 DOM 查询（用 ref/Context 替代） | P1 | 组件封装性 |
| 11 | 将魔法数字提取为命名常量 + CSS 变量 | P2 | 可维护性 |
| 12 | 合并 `index.css` 两个 `:root` 块 | P2 | CSS 清晰度 |

### 第三阶段：精进（预计 2-3 周）

| # | 任务 | 优先级 | 预期效果 |
|---|------|--------|----------|
| 13 | 为 `storageService`、`pixivApi`、`utils` 编写单元测试 | P0 | 回归保护 |
| 14 | IndexedDB 一次性格式迁移（清理 v1-v10 遗留） | P2 | 减少运行时开销 |
| 15 | `cacheDB.js` 迁移系统重构 | P2 | 可维护性 |
| 16 | `pixivApi.js` 按域拆分子模块 | P2 | 文件大小控制 |
| 17 | 补充组件 JSDoc（覆盖所有 public props） | P2 | 文档完整性 |
| 18 | 拆分 `index.css` 剩余全局样式到 `styles/` | P2 | CSS 模块化 |
| 19 | 删除 `PreviewModal.jsx`（如果 MediaLightbox 已替代） | P2 | 清理死代码 |

### 第四阶段：卓越（持续）

| # | 任务 | 优先级 | 预期效果 |
|---|------|--------|----------|
| 20 | 全量 TypeScript strict 模式 | P3 | 类型安全 |
| 21 | 配置 CI（lint + test + build） | P3 | 质量门禁 |
| 22 | 添加无障碍（ARIA label、键盘导航） | P3 | 可用性 |
| 23 | 性能基准测试 + 监控 | P3 | 性能可见性 |
| 24 | E2E 测试（Playwright/Cypress） | P3 | 端到端覆盖 |

---

## 10. 附录：文件清单与评级

```
src/
├── App.css                          # 🔴 100% 死代码（Vite 模板残留）
├── App.jsx                          # 🟡 耦合中心
├── index.css                        # 🟡 743 行过大
├── main.jsx                         # ✅ 干净
│
├── api/
│   ├── gif.js                       # ✅ 亮点：优秀的多层降级设计
│   ├── index.js                     # 🔵 历史兼容层
│   └── pixiv.js                     # ✅ 平台自适应 HTTP
│
├── components/
│   ├── AuthorWorksPage.jsx          # 🟡 手动重实现无限滚动
│   ├── DownloadMonitor.jsx          # ✅ 规范的 useSyncExternalStore
│   ├── ErrorBoundary.jsx            # ✅ 类组件模式正确
│   ├── FrameAnimPlayer.jsx          # 🟡 548 行需要拆分
│   ├── GifPlayer.jsx                # ✅ 干净委托
│   ├── ImageGrid.jsx                # ✅ 清洁展示组件
│   ├── LightboxActions.jsx          # ✅ 正确但事件总线可改进
│   ├── MediaLightbox.jsx            # 🟡 396 行 renderVideoContent 复杂
│   ├── NeedCookieNotice.jsx         # ✅ 最小化
│   ├── PageHeader.jsx               # 🔵 CSS 类名是 chat 遗留
│   ├── PreviewModal.jsx             # 🔵 可能是死代码
│   ├── PullToRefresh.jsx            # 🟡 直接 DOM 查询
│   ├── SettingsModal.jsx            # 🔵 无表单验证
│   ├── TabBar.jsx                   # 🔵 无 ARIA
│   ├── ToastHost.jsx                # 🔵 定时器未清理
│   ├── UgoiraPlayer.jsx             # ✅ 干净委托
│   ├── detail/
│   │   ├── DetailView.jsx           # 🟡 直接 DOM 查询 + scrollMap 泄漏
│   │   ├── ImageDetailView.jsx      # 🟡 421 行 + O(n²) 去重
│   │   └── helpers.js               # 🔵 混杂 AI 角色系统代码
│   └── icons/
│       ├── HeartIcon.jsx            # ✅ 干净
│       └── SearchIcon.jsx           # ✅ 干净
│
├── context/
│   ├── pixivCacheContext.js         # 🔴 与 Zustand store 重复
│   └── PixivCacheProvider.jsx       # 🔴 与 Zustand store 重复
│
├── hooks/
│   ├── useImagePreloader.js         # 🔵 模块级 Set
│   ├── useStableCallback.js         # ✅ 正确实现
│   ├── useTabFeed.js                # ✅ 设计好，但未全面采用
│   └── useTouchGesture.js           # ✅ 亮点：专业级手势引擎
│
├── pages/
│   ├── BookmarksPage.jsx            # 🔵 API 字段名不统一
│   ├── DiscoverPage.jsx             # ✅ 规范的 useTabFeed 用法
│   ├── GalleryPage.jsx              # 🟡 未使用 useTabFeed
│   ├── RankingPage.jsx              # 🟡 未使用 useTabFeed + refreshToken 误导
│   └── SearchPage.jsx               # ✅ Portal 模式合理
│
├── pixiv-assistant/
│   ├── index.js                     # 🔵 Barrel 重叠
│   ├── capacitor/
│   │   ├── cacheDB.js               # 🟡 10 版本内联迁移 + IIFE 泄露
│   │   ├── config.js                # 🔵 cookie 构建时打包
│   │   ├── entity.js                # 🔵 旧格式兼容逻辑
│   │   ├── fileStore.js             # 🔵 _resolveDir 忽略参数
│   │   ├── gallery.js               # 🔵 权限无缓存
│   │   ├── index.js                 # 🔵 Barrel 重叠
│   │   ├── networkStore.js          # ✅ 多层降级策略
│   │   ├── repository.js            # 🟡 每次 find 检查旧 key
│   │   ├── storageFacade.js         # 🔵 大量透传方法
│   │   ├── storageService.js        # ✅ 亮点：依赖注入 + JSDoc 完善
│   │   ├── tabCache.js              # 🟡 第二个独立 IndexedDB
│   │   └── transitionEngine.js      # 🔵 Saga 过度设计
│   └── core/
│       ├── constants.js             # 🔵 CACHE_DIR 用了旧项目名
│       ├── pixivApi.js              # 🟡 521 行需拆分
│       ├── types.js                 # 🔵 缺少 PixivEntity 类型
│       └── utils.js                 # 🔵 parseCacheFileName 8 种格式
│
├── router/                          # 🔵 空目录
│
├── store/
│   ├── useAppStore.js               # 🟡 DOM 查询在 store 中
│   └── usePixivCacheStore.js        # 🔴 与 Context 重复
│
├── styles/
│   ├── detail.css                   # ✅ 模块化
│   ├── download.css                 # ✅ 模块化
│   ├── lightbox.css                 # 🔵 animation: lightboxIn 未定义
│   └── search.css                   # 🟡 硬编码颜色
│
└── utils/
    ├── backHandler.js               # 🔵 500ms 防抖
    ├── downloadMonitor.js           # ✅ 规范的外部 store
    ├── logger.js                    # ✅ 简洁
    ├── nativeDownload.js            # ✅ 干净
    ├── performance.js               # 🔵 window 全局污染
    ├── quality.js                   # 🔵 默认参数在加载时求值
    ├── storageFeedback.js           # 🔵 错误匹配可能丢上下文
    └── toast.js                     # 🔵 seq 不重置
```

---

## 图例

| 标记 | 含义 |
|------|------|
| 🔴 | 严重——必须修复 |
| 🟡 | 中度——近期应修复 |
| 🔵 | 轻度——可逐步改进 |
| ✅ | 良好——保持现状 |

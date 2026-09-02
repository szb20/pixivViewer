# PixivViewer 项目审查报告

> 审查日期：2026-08-03  
> 审查范围：全项目代码审查  
> 代码量：~40 个源文件，约 6000 行

---

## 项目概况

| 项目 | 内容 |
|------|------|
| 框架 | React 19 + Vite 8 + Capacitor 8 |
| 目标平台 | Web（dev）/ Android（prod） |
| 存储 | IndexedDB（元数据）+ Capacitor Filesystem（图片文件） |
| 代理 | Vite dev server 中间件 + Clash 代理 |
| 语言 | JavaScript（JSX） |
| 构建工具 | Vite 8 |
| 代码检查 | oxlint |

---

## 目录

1. [代码重复与复用](#1-代码重复与复用)
2. [性能优化](#2-性能优化)
3. [依赖管理](#3-依赖管理)
4. [代码质量与可维护性](#4-代码质量与可维护性)
5. [架构设计](#5-架构设计)
6. [存储与数据层](#6-存储与数据层)
7. [安全检查](#7-安全检查)
8. [UI 提示与弹窗审查](#8-ui-提示与弹窗审查)
9. [优化路线图](#9-优化路线图)
6. [存储与数据层](#6-存储与数据层)
7. [安全检查](#7-安全检查)
8. [优化路线图](#8-优化路线图)

---

## 1. 代码重复与复用

### 1.1 🔴 GifPlayer 与 UgoiraPlayer 高度重复

**文件**：`src/components/GifPlayer.jsx`（425行）、`src/components/UgoiraPlayer.jsx`（360行）

**问题**：两个组件几乎完全相同，都是 Canvas 逐帧动画播放器，共享以下重复逻辑：

- 帧下载缓存（`downloadCache` Map）
- 帧预加载（Image 对象数组，loadedCount 计数）
- `requestAnimationFrame` 逐帧播放
- 首帧渲染、缓存恢复、暂停/继续
- 下载进度与播放进度条
- 缩略图兜底、加载中指示器、错误重试

**建议**：合并为一个通用 `CanvasAnimPlayer` 组件，差异点通过参数控制：

```jsx
// 核心播放器
export function CanvasAnimPlayer({ 
  frames, illustId, title, author,
  loadFrames,      // 函数：如何加载帧数据
  progressBar,     // 'bar' | 'circle' | null
  showError,       // boolean
  ...rest 
}) { /* 核心逻辑 */ }

// GifPlayer 只是薄包装
export default function GifPlayer(props) {
  return <CanvasAnimPlayer {...props} progressBar="circle" showError />;
}
```

### 1.2 🔴 Tab 页面大量重复模式

**涉及文件**：
- `src/pages/DiscoverPage.jsx`
- `src/pages/RankingPage.jsx`
- `src/pages/BookmarksPage.jsx`
- `src/pages/SearchPage.jsx`

**问题**：四个页面有完全相同的结构模式，每个文件约 100-175 行，其中 ~70% 是重复代码：

| 重复模式 | 出现次数 |
|----------|---------|
| 缓存水合（loadTabCache → hydrated → firstFetchDoneRef） | 4 次 |
| IntersectionObserver 无限滚动哨兵 | 4 次 |
| loadRef + refreshToken 强制刷新 | 3 次 |
| loading/loadingMore/error/hasMore 状态管理 | 4 次 |
| itemsRef 双缓冲避免闭包陷阱 | 4 次 |

**建议**：提取两个通用 hook：

```jsx
// 1. Tab 缓存 + 数据加载 hook
function useTabCache(key, fetcher, opts) {
  // 封装：缓存水合 → 首次加载 → refreshToken 强制刷新
  // 返回：{ items, loading, error, hasMore, loadMore, refresh }
}

// 2. 无限滚动 hook
function useInfiniteScroll(sentinelRef, { hasMore, loading, onLoadMore }) {
  // 封装 IntersectionObserver
}
```

---

## 2. 性能优化

### 2.1 🔴 useSavedSet 全量扫描

**文件**：`src/hooks/useSavedSet.js`

**问题**：每次挂载都调用 `storageFacade.getAll()` 获取所有 entity 记录。每个 Tab 页面都用这个 hook，且 App 启动时 (`App.jsx:97`) 也调了一次 `getAll()`。对于数千张缓存的用户，这会造成：

- 多次 IndexedDB 全表扫描
- 大量 JS 对象创建和 Set 构建
- 内存占用随缓存量线性增长

**建议**：
- 在 App 层集中加载一次，通过 Context 共享
- 或改用分页查询 + 增量更新
- 或维护一个轻量级 `savedIdSet` 缓存（仅存储 ID 列表，不存完整 entity）

### 2.2 🟡 pixivCache 状态管理导致级联重渲染

**文件**：`src/App.jsx`

**问题**：
- `pixivCache` 是一个巨大的扁平对象，存储在 App 组件内
- `setPixivCache(prev => ({...prev, ...}))` 每次更新都创建新对象
- `likedSet` 的 `useMemo` 每次遍历整个对象
- `setPixivCache` 作为 prop 向下穿透 5 层（App → DetailView → ImageDetailView → DetailPageBlock → LightboxActions）

**建议**：
- 使用 `useSyncExternalStore` 或 Context 拆分状态
- 将 `pixivCache` 拆分为 `likedSet` 和 `savedSet` 两个独立状态
- 或迁移到 `useReducer` 减少不必要的重渲染

### 2.3 🟡 内存泄漏风险

**文件**：`src/components/detail/ImageDetailView.jsx`

**问题**：
- `originalCacheRef` 存储所有已加载原图的 blob URL，只在组件卸载时释放
- 用户在详情页浏览大量作品后，blob URL 持续累积
- 部分 blob URL 在 `useEffect` 卸载时未及时释放就已被覆盖

**建议**：限制缓存大小（LRU），或降低保存全量原图引用的粒度。

### 2.4 🟡 图片预加载范围

**文件**：`src/components/MediaLightbox.jsx`

**问题**：`useEffect` 中预加载前 2 张和后 2 张图片，在灯箱场景中合理。但相关推荐网格中所有图片同时设置了 `loading="lazy"`，没有优先级控制。

**建议**：首屏前 4 张设为 `eager`，其余 `lazy`。

---

## 3. 依赖管理

### 3.1 🔴 https-proxy-agent 误放 production dependencies

**文件**：`package.json`

```json
"dependencies": {
  "https-proxy-agent": "^9.1.0",  // ← 只用于 dev server！
  ...
}
```

**问题**：`https-proxy-agent` 只被 `scripts/pixiv-proxy.mjs` 和 `scripts/proxy-utils.mjs` 使用——这些是 Node.js Vite dev server 中间件，在 Android 生产构建中不会被打包。

**建议**：移到 `devDependencies`。

### 3.2 🟢 依赖健康状况

| 依赖 | 版本 | 状态 |
|------|------|------|
| react | ^19.2.8 | ✅ 最新 |
| react-dom | ^19.2.8 | ✅ 最新 |
| vite | ^8.2.0 | ✅ 最新 |
| TypeScript | ^7.0.2 | ✅ 最新（但未使用） |
| @capacitor/* | ^8.x | ✅ 最新 |
| oxlint | ^1.75.0 | ✅ 最新 |
| jszip | ^3.10.1 | ✅ 稳定 |
| gifenc | ^1.0.3 | ✅ 稳定 |

---

## 4. 代码质量与可维护性

### 4.1 🟡 生产代码中残留大量 console.log

**涉及文件与行数**：

| 文件 | 行数 | 内容 |
|------|------|------|
| `src/components/detail/ImageDetailView.jsx` | 多处 | 滚动位置、图片加载日志 |
| `src/components/detail/DetailView.jsx` | 3 处 | 栈操作日志 |
| `src/api/pixiv.js` | 1 处 | URL 构建日志 |
| `src/pixiv-assistant/capacitor/storageService.js` | 2 处 | 下载日志 |
| `src/pixiv-assistant/core/utils.js` | 2 处 | URL 匹配兜底日志 |
| `src/pixiv-assistant/capacitor/networkStore.js` | 2 处 | 下载日志 |

**建议**：包装一个 Logger 工具，dev 环境输出、prod 环境静默：

```js
// src/utils/logger.js
const DEV = import.meta.env.DEV;
export const logger = {
  log: (...args) => DEV && console.log(...args),
  warn: (...args) => DEV && console.warn(...args),
  error: (...args) => console.error(...args), // 生产也保留错误
};
```

### 4.2 🟡 全局 window.api 对象

**文件**：`src/api/index.js`

```js
window.api = {
  storageFacade, fetchIllust, fetchRelated,
  toggleLike, fetchGif, cachePixivImage, ...
};
```

**问题**：各组件通过 `window.api.storageFacade` 等全局对象调用，不利于：
- 类型检查和 IDE 自动补全
- 单元测试（难以 mock）
- 模块依赖追踪

**建议**：
- 使用 React Context 注入
- 或至少添加 JSDoc 类型声明
- 或导出 typed 对象供组件直接 import

### 4.3 🟢 缺少 TypeScript 类型检查

**问题**：项目依赖了 `typescript: ^7.0.2`，但所有源文件都是 `.jsx`/`.js`。核心数据模型（PixivEntity、API 响应、配置对象）类型复杂，纯 JS 容易漏传/错传字段。

**建议**：至少给核心数据模型加 `.d.ts` 类型声明，或逐步迁移 `/pixiv-assistant/core/` 和 `entity.js` 到 TS。

### 4.4 🟢 IndexedDB 迁移逻辑膨胀

**文件**：`src/pixiv-assistant/capacitor/cacheDB.js`

**问题**：`DB_VERSION = 10`，`onupgradeneeded` 里有从 v1 到 v10 的所有迁移代码（约 150 行），随着版本增加会越来越难维护。

**建议**：拆分迁移函数到独立文件，按版本号映射：

```js
const MIGRATIONS = {
  2: migrateV1ToV2,
  3: migrateV2ToV3,
  // ...
  10: migrateV9ToV10,
};
```

---

## 5. 架构设计

### 5.1 🟢 路由系统

**问题**：没有 React Router，Tab 切换靠 `display: none` 保持所有已访问页面挂载在 DOM 中。

**优点**：Tab 切换时保持滚动位置，切回即用，体验好。

**缺点**：
- 所有已访问页面始终在内存中，缓存量大的页面累积 DOM 节点
- 搜索历史、推荐数据等不会自动清理
- 页面间通信靠 props 穿透（onOpen、likedSet 等）

**建议**：当前方案对 Tab 切换体验好，可长期使用。可以考虑 `keep-alive` 风格的缓存方案，或在 visitedTabs 上增加最大数量限制。

### 5.2 🟢 存储架构

```
StorageFacade (UI 门面层)
  └─ PixivStorageService (业务编排层)
       ├─ PixivRepository (数据映射层)
       │    └─ cacheDB.js (IndexedDB 操作)
       ├─ FileStore (文件操作层)
       │    └─ Capacitor Filesystem
       ├─ TransitionEngine (状态迁移引擎 - Saga 模式)
       └─ NetworkStore (网络下载层)
```

**评价**：存储架构分层清晰，`TransitionEngine` 的 Saga 补偿模式是亮点。但 `StorageFacade` 中混入了 Toast 逻辑，职责不够单一。

### 5.3 🟢 代理架构

```
Vite Dev Server
  ├─ /pixiv-api/* → createApiProxy('https://www.pixiv.net')  → Clash 代理
  ├─ /pixiv-img/* → pixivImageProxy().img                      → i.pixiv.re / pixiv.re
  ├─ /pixiv-thumb/* → createImageProxy('https://i.pixiv.re')   → i.pixiv.re
  └─ /pixiv-zip/* → pixivImageProxy().zip                      → Pixiv 原始 ZIP
```

**评价**：代理架构清晰，支持自动重试、Agent 重置、代理可用性检查。`createAgentHolder` 的故障恢复机制设计良好。

---

## 6. 存储与数据层

### 6.1 🟢 正向亮点

- **统一 Entity 模型**：`PixivEntity` 作为全系统统一数据模型，各层间通信不直接操作原始 IndexedDB 记录
- **Saga 补偿模式**：`TransitionEngine` 的状态迁移失败时倒序回滚，保证数据一致性
- **幂等设计**：save/unsave/toggleLike 都是幂等的，避免重复操作
- **去重保存**：`StorageFacade._saveInFlight` 防止并发重复下载

### 6.2 🟡 存储层观察

- `saveFromNetwork` 中图片下载失败后降级重试（多候选 URL），但重试过程没有超时控制
- FileStore 的 `cached` 和 `saved` 状态解析为同一目录（`DOCUMENTS/TeyvatWhisper`），失去了状态分离的意义
- IndexedDB 的 `cleanTitles` 脚本在模块加载时立即执行，可能影响启动速度

---

## 7. 安全检查

### 7.1 ✅ Cookie 安全

- Cookie 仅存在 `localStorage` 中，未持久化到不安全位置
- Dev 模式下通过 `x-pixiv-cookie` 自定义头透传，避免浏览器拦截 `Cookie` 头
- Prod 模式下使用 CapacitorHttp 直接设置 Cookie

### 7.2 ✅ 图片 URL 代理

- 所有 `i.pximg.net` 图片 URL 统一转为 `i.pixiv.re` 代理，避免 Referer 泄露
- 缩略图通过 `/pixiv-thumb` 代理，增加缓存控制头

### 7.3 🟡 注意点

- `localStorage` 存储 Cookie 未加密，在 Android WebView 中可能被其他应用读取
- 建议在 Android 上使用 Capacitor 的 `Preferences` API 或加密存储

---

## 8. UI 提示与弹窗审查

> 审查日期：2026-08-05 | 范围：所有 Toast、弹窗、告警提示的视觉样式与交互

### 8.1 Toast（通用轻提示）⭐⭐⭐⭐

**文件：** `src/utils/toast.js` + `src/components/ToastHost.jsx` + `src/index.css:713-752`

**当前样式：**
- 顶部居中定位：`top: calc(env(safe-area-inset-top, 20px) + 28px)`
- 毛玻璃底 `rgba(255,255,255,0.12)` + `backdrop-filter: blur(12px)`
- 13px 白色字 + 三层 text-shadow 文字发光
- 圆角 20px、0.2s fade-in + slide-down 动画
- 2.5 秒自动消失

**评价：毛玻璃层次好，位置避开状态栏，动画干净。** 小问题：三层 text-shadow（`0 0 8px/20px/40px`）在浅色图片上方文字略显发虚；可减为两层或降低 spread。

```css
/* 建议：减为两层，更有质感 */
text-shadow: 0 0 8px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.5);
```

---

### 8.2 Settings 设置弹窗 ⭐⭐⭐⭐

**文件：** `src/components/SettingsModal.jsx` + `src/index.css:576-654`

**当前样式：**
- 底部弹出 sheet（`align-items: flex-end`），居中 `max-width: 560px`
- 圆角 `16px 16px 0 0`，`background: var(--bg-panel)`
- input/select 字段：`background: var(--bg-secondary)`，focus 变 accent 色边框
- 保存成功用 inline 绿色 hint，900ms 后自动关闭弹窗

**评价：底部 sheet 风格适合手机操作，字段间距合理。** 两个问题：

**问题 1：** 保存成功提示 900ms 后弹窗关闭——用户可能没看到就没了。建议改为 Toast 通知，或至少在关闭前等待 2 秒。

**问题 2：** `.modal` 无 `max-height`、无 `overflow-y: auto`——未来加字段（如多语言、主题切换）可能溢出屏幕。建议添加：
```css
.modal {
  max-height: 85vh;
  overflow-y: auto;
}
```

---

### 8.3 Cookie 引导条 ⭐⭐⭐

**文件：** `src/components/NeedCookieNotice.jsx` + `src/index.css:496-519`

**当前样式：**
- Flex 横排，蓝色半透明底 `rgba(79,140,255,0.12)` + 蓝色文字
- 圆角 8px，`margin: 12px 0`
- 右侧蓝色按钮"去设置"

**评价：色彩区分度好。** 但它内联在内容流——如果列表为空（还没有搜索结果/收藏），这条可能被 scroll 推出视野，用户根本看不到。建议改成 sticky/fixed 定位，或只在内容区域为空时居中展示。

---

### 8.4 代理连接失败弹窗 ⭐⭐⭐

**文件：** `src/components/ProxyCheckNotice.jsx` + `src/index.css:801-897`

**当前样式：**
- 全屏遮罩 `rgba(0,0,0,0.65)`，`z-index: 500`
- 居中卡片 `max-width: 340px`，圆角 16px，带 `.frosted` 毛玻璃
- 进入动画：overlay fade + 卡片 scale+fade
- 两个按钮（去设置 / 重试）

**问题 1：z-index 冲突。** `proxy-check-overlay` 的 `z-index: 500` 远高于 SettingsModal 的 `z-index: 100`。用户点击"去设置"时，`onDismiss()` + `onOpenSettings()` 同步执行——设置弹窗的遮罩层（`modal-overlay: z-index 100`）低于代理弹窗的遮罩（500），导致设置弹窗被代理遮罩压住。

**修复：** `handleGoSettings` 中先关自己再延迟打开设置：
```js
const handleGoSettings = () => {
  onDismiss();
  setTimeout(onOpenSettings, 150); // 等 fade-out 动画结束后再打开
};
```

**问题 2：** `.proxy-check-card` 用了 `.frosted` 但无额外卡片质感——`.frosted` 只给了 `background: rgba(15,17,21,0.55)`，在深色遮罩上缺乏层次。建议加一层浅色边框阴影或提升 `background` 的透明度。

**问题 3：** Proxy URL 用 `monospace` 字体——对普通用户不友好。建议用更小字号 + 省略号截断，monospace 仅用于调试模式。

---

### 8.5 下载进度弹窗 ⭐⭐⭐⭐⭐

**文件：** `src/components/DownloadMonitor.jsx` + `src/styles/download.css`

**当前样式：**
- 毛玻璃全屏 sheet：`backdrop-filter: blur(40px) saturate(180%)`，圆角 32px
- 每行：圆角 24px，半透明底，带标题 + 状态 + SVG 圆环进度
- 悬浮按钮：`position: fixed; right: 16px; bottom` 与 like 按钮同步上移
- 角标：红色圆点 + 数字

**评价：项目中最好的一块 UI。** 32px 大圆角、blur(40px) 强模糊、SVG 圆环进度——质感很强。

小问题：
- `.download-fab` 的 `bottom` 值硬编码与 `.detail-floating-like` 同步——如果在非详情页（按钮不显示时），下载按钮位置会偏上。建议用 CSS 变量统一管理悬浮按钮的 bottom 值。
- `.download-overlay` 用了 `@supports (backdrop-filter: blur())` 做兼容性 fallback，但 `@supports` 外无 `background`，不支持 blur 的浏览器上遮罩完全透明。
```css
/* 建议：加 fallback 背景色 */
.download-overlay {
  background: rgba(0, 0, 0, 0.55); /* fallback */
}
@supports (backdrop-filter: blur()) {
  .download-overlay {
    background: rgba(0, 0, 0, 0.35);
  }
}
```

---

### 8.6 ErrorBoundary Fallback ⭐⭐

**文件：** `src/components/ErrorBoundary.jsx:42-72`

**当前样式：**
```jsx
<div className="error-boundary" style={{
    padding: '24px', textAlign: 'center',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    minHeight: '200px',
}}>
    <h2 style={{ margin: '0 0 12px', fontSize: '18px' }}>出了点问题</h2>
    <p style={{ margin: '0 0 16px', color: '#666', fontSize: '14px' }}>
        {this.state.error?.message || '页面加载失败'}
    </p>
    <button style={{
        padding: '8px 20px', borderRadius: '8px',
        border: 'none', background: '#0096fa',
        color: '#fff', fontSize: '14px', cursor: 'pointer',
    }}>重试</button>
</div>
```

**评价：最需要改进的一个。** 三个核心问题：

**问题 1：** 全部硬编码颜色——`#0096fa`（非 `var(--accent)`）、`#666`（非 `var(--text-tertiary)`），不跟随 CSS 变量，主题切换时完全不变。

**问题 2：** `.error-boundary` 类名在 `index.css` 中无对应规则，实际上被内联 style 覆盖，浪费了一个语义类名。

**问题 3：** `color: '#666'` 在深色背景（`#000`/`var(--bg)`）上对比度极低（2.6:1），几乎不可读。

**建议：** 移到独立 CSS，使用 CSS 变量：
```css
.error-boundary {
  padding: 24px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  color: var(--text-primary);
}
.error-boundary h2 { margin: 0 0 12px; font-size: 18px; }
.error-boundary p { margin: 0 0 16px; color: var(--text-secondary); font-size: 14px; }
.error-boundary button {
  padding: 8px 20px; border-radius: 8px; border: none;
  background: var(--accent); color: #fff; font-size: 14px; cursor: pointer;
}
```

---

### 8.7 `.hint` 通用提示 ⭐⭐⭐

**文件：** `src/index.css:521-526`

```css
.hint {
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
  padding: 8px 0 4px;
}
```

**用途：** Feed 列表中的"正在加载..."、"没有更多"、SettingsModal 中的 PHPSESSID 获取说明、GalleryPage 的空状态提示。

**评价：简单够用。** Settings 中"获取方式"用 `style={{ textAlign: 'left', padding: '4px 0 0' }}` 覆盖 `.hint` 默认值——如果这种左对齐 hint 出现多次，值得抽一个 `.hint-left` 变体。

---

### 8.8 详情页错误提示 ⭐⭐⭐⭐

**文件：** `src/components/detail/ImageDetailView.jsx:137` + `src/styles/detail.css:228-236`

```css
.image-detail-error {
  width: 100%; height: 200px;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-tertiary); font-size: 13px;
}
```

**评价：语义清晰，足够简单。**

---

### 8.9 汇总

| 组件 | 评分 | 主要问题 |
|------|------|---------|
| Toast | ⭐⭐⭐⭐ | 文字发光三层略重 |
| SettingsModal | ⭐⭐⭐⭐ | 保存反馈太快消失；无 max-height/overflow |
| CookieNotice | ⭐⭐⭐ | 内联在内容流，空列表时可能不可见 |
| ProxyCheckNotice | ⭐⭐⭐ | z-index 与 SettingsModal 冲突；卡片层次弱 |
| DownloadMonitor | ⭐⭐⭐⭐⭐ | 仅 fallback 遮罩缺失 |
| ErrorBoundary | ⭐⭐ | 硬编码颜色；`#666` 在深色背景不可读 |
| .hint | ⭐⭐⭐ | 缺少左对齐变体 |
| detail-error | ⭐⭐⭐⭐ | 够用 |

**优先级：值得修**

| 优先级 | 组件 | 改动 |
|--------|------|------|
| 1 | ErrorBoundary | 内联 style → CSS 变量，修复深色背景可读性 |
| 2 | ProxyCheckNotice | z-index 冲突，`setTimeout` 延迟打开设置 |
| 3 | SettingsModal | 加 `max-height` + `overflow-y: auto`，保存反馈改用 Toast |
| 4 | Toast | 文字发光减为两层 |
| 5 | DownloadMonitor | fallback 遮罩背景色 |

---

## 9. 优化路线图

### 第一阶段：快速见效（1-2 天）

| 事项 | 预估 | 影响 |
|------|------|------|
| 移动 https-proxy-agent 到 devDependencies | 5 分钟 | 减少生产包体积 |
| 清理 console.log 或包装 logger | 30 分钟 | 减少日志噪音 |
| 合并 GifPlayer / UgoiraPlayer | 2 小时 | 消除 400 行重复代码 |

### 第二阶段：架构优化（3-5 天）

| 事项 | 预估 | 影响 |
|------|------|------|
| 提取 Tab 页面通用 hook | 3 小时 | 消除 4 个页面 70% 重复 |
| 优化 useSavedSet 全量扫描 | 1 小时 | 减少启动时 IndexedDB 压力 |
| 拆分 pixivCache 状态管理 | 2 小时 | 减少级联重渲染 |

### 第三阶段：工程化提升（持续）

| 事项 | 影响 |
|------|------|
| 核心模块迁移 TypeScript | 提升类型安全 |
| IndexedDB 迁移拆分 | 降低维护成本 |
| 添加单元测试覆盖存储层 | 提升代码可靠性 |
| 引入 E2E 测试 | 保证核心流程稳定 |

---

## 附录：文件清单

```
src/
├── api/
│   ├── gif.js          # Ugoira 动图加载（ZIP→帧→GIF编码）
│   ├── index.js        # window.api 兼容层
│   └── pixiv.js        # Pixiv API 适配层（dev fetch / prod CapacitorHttp）
├── components/
│   ├── detail/
│   │   ├── DetailView.jsx       # 详情页切换栈
│   │   ├── ImageDetailView.jsx  # 详情页内容（大图+信息+推荐）
│   │   └── helpers.js           # 数据处理工具（含 CharStatePanel 遗留）
│   ├── GifPlayer.jsx            # GIF 动图播放器
│   ├── UgoiraPlayer.jsx         # Ugoira 动图播放器（几乎重复）
│   ├── ImageGrid.jsx            # 双列图片网格
│   ├── MediaLightbox.jsx        # 统一媒体灯箱
│   ├── LightboxActions.jsx      # 灯箱操作按钮
│   ├── TabBar.jsx               # 底部导航栏
│   ├── ToastHost.jsx            # Toast 渲染
│   ├── SettingsModal.jsx        # 设置弹窗
│   ├── PreviewModal.jsx         # 简易预览（过渡）
│   ├── NeedCookieNotice.jsx     # Cookie 引导条
│   ├── PageHeader.jsx           # 通用页面标题栏（遗留）
│   └── icons/
│       └── HeartIcon.jsx         # 爱心 SVG 图标
├── pages/
│   ├── DiscoverPage.jsx   # 推荐页
│   ├── RankingPage.jsx    # 排行榜页
│   ├── BookmarksPage.jsx  # 收藏夹页
│   ├── SearchPage.jsx     # 搜索页
│   └── GalleryPage.jsx    # 本地喜欢页
├── hooks/
│   ├── useSavedSet.js     # 已保存作品集合 hook
│   └── useTouchGesture.js # 灯箱触摸手势引擎
├── pixiv-assistant/
│   ├── index.js                 # 统一导出
│   ├── core/
│   │   ├── constants.js         # 常量
│   │   ├── pixivApi.js          # Pixiv API 工厂
│   │   ├── types.js             # 类型定义（待完善）
│   │   └── utils.js             # 工具函数
│   └── capacitor/
│       ├── cacheDB.js           # IndexedDB 元数据存储
│       ├── config.js            # 配置管理
│       ├── entity.js            # PixivEntity 统一数据模型
│       ├── fileStore.js         # 文件操作
│       ├── index.js             # 导出
│       ├── networkStore.js      # 网络下载
│       ├── repository.js        # 数据映射层
│       ├── storageFacade.js     # UI 门面
│       ├── storageService.js    # 业务编排层
│       ├── tabCache.js          # Tab 结果缓存
│       └── transitionEngine.js  # 状态迁移引擎
├── utils/
│   ├── backHandler.js  # 系统返回键处理
│   ├── quality.js      # 画质档位工具
│   └── toast.js        # Toast 事件广播
├── styles/
│   ├── detail.css
│   └── lightbox.css
├── App.jsx
├── App.css
├── index.css
└── main.jsx
scripts/
├── pixiv-proxy.mjs   # Pixiv 代理中间件
├── proxy-utils.mjs   # 通用代理工具
└── mix-repro.mjs     # 遗留工具
```
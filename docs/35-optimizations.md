# pixivViewer 35 个优化点

> 日期：2026-08-04 | 补充审查（避开架构审查已提及的问题）

---

## 目录

1. [性能 (7)](#一性能优化-7个)
2. [错误处理 (3)](#二错误处理-3个)
3. [内存泄漏 (3)](#三内存泄漏-3个)
4. [代码重复 (4)](#四代码重复-4个)
5. [API 调用 (3)](#五api-调用-3个)
6. [状态管理 (3)](#六状态管理-3个)
7. [CSS (4)](#七css-4个)
8. [可访问性 (3)](#八可访问性-3个)
9. [安全性 (2)](#九安全性-2个)
10. [健壮性 (3)](#十健壮性-3个)

---

## 一、性能优化（7个）

### OPT-01：useTouchGesture 返回值无 useMemo

- **文件：** `src/hooks/useTouchGesture.js` 第 743-744 行
- **严重度：** 🟡

**当前代码：**
```js
return {
    overlayRef, trackRef, slideRefs,
    index, closing, hideUI, setHideUI,
    swipeOff, pinchScale, pinchPan, zoomTrans,
    cur, isGif, hasPrev, hasNext,
    handleTouchStart, handleTouchMove, handleTouchEnd,
    handleClose, handleOverlayClick, handleDoubleTap,
    nav, navPage, findAdjacentPage, cancelSpring,
    applyTransform,
};
```

**问题：** 返回 20+ 个属性/函数，每次渲染都创建全新对象引用。`MediaLightbox` 解构这个返回值后，子组件会因引用变化而重渲染。

**优化：**
```js
const stableApi = useMemo(() => ({
    handleTouchStart, handleTouchMove, handleTouchEnd,  // useCallback 已有
    handleClose, handleOverlayClick, handleDoubleTap,   // useCallback 已有
    nav, navPage, findAdjacentPage, cancelSpring,        // useCallback 已有
    applyTransform,                                       // useCallback 已有
}), [handleTouchStart, handleTouchMove, handleTouchEnd, handleClose,
    handleOverlayClick, handleDoubleTap, nav, navPage,
    findAdjacentPage, cancelSpring, applyTransform]);
```

---

### OPT-02：App.jsx 5 个 Tab 的内联 style 对象

- **文件：** `src/App.jsx` 第 78-132 行
- **严重度：** 🔵

**当前代码：**
```jsx
<div style={{ display: activeTab === 'discover' ? undefined : 'none' }}>
<div style={{ display: activeTab === 'ranking' ? undefined : 'none' }}>
// ... 重复 5 次
```

**问题：** 每次渲染创建 5 个新 style 对象。

**优化：**
```js
const SHOW = { display: undefined };
const HIDE = { display: 'none' };
// 使用: <div style={activeTab === 'discover' ? SHOW : HIDE}>
```

---

### OPT-03：ImageDetailView Array.from 每渲染重建

- **文件：** `src/components/detail/ImageDetailView.jsx` 第 449 行
- **严重度：** 🔵

**当前代码：**
```jsx
{Array.from({ length: pageCount }, (_, p) => (
    <DetailPageBlock key={`${image.illustId}-${p}`} ... />
))}
```

**问题：** `Array.from` 每次渲染创建新数组，所有 `DetailPageBlock` 都重新渲染。

**优化：**
```js
const pageIndices = useMemo(
    () => Array.from({ length: pageCount }, (_, i) => i),
    [pageCount]
);
// 使用: pageIndices.map(p => <DetailPageBlock key={...} ... />)
```

---

### OPT-04：cacheDB.js IIFE 阻塞首次 DB 打开

- **文件：** `src/pixiv-assistant/capacitor/cacheDB.js` 第 564-590 行
- **严重度：** 🔴

**当前代码：**
```js
(async function cleanTitles() {
    const db = await openDB();
    const all = await getAllMeta(db);
    for (const record of all) {
        // 清理标题
    }
    await putMetaBatch(db, modified);
})();
```

**问题：** 模块加载时立即执行 IIFE，读取全表、遍历清理、写回。大数据集下首次 App 打开有明显延迟。

**优化：** 改为在 DB 版本升级时执行单次迁移（`onupgradeneeded` 中），或用 `_meta_titles_cleaned_v2` 标记避免重复执行。使用 `requestIdleCallback` 拆分批次。

---

### OPT-05：FrameAnimPlayer 帧预加载 useEffect 依赖数组引用

- **文件：** `src/components/FrameAnimPlayer.jsx` 第 273-330 行
- **严重度：** 🟡

**当前代码：**
```js
useEffect(() => {
    // 帧预加载逻辑（创建 Image 对象）
}, [frames, illustId]);
```

**问题：** `frames` 是数组引用，内容相同但引用不同时，整个预加载重复——旧的 `Image` 对象被丢弃、新的重新下载。

**优化：** 用 `useRef` 存上次 `frames` 的内容，浅比较判断是否真的需要重新预加载。或者使用帧 URL 的字符串序列作为依赖。

---

### OPT-06：FrameAnimPlayer playFrame 中 img.complete 不充分

- **文件：** `src/components/FrameAnimPlayer.jsx` 第 353 行
- **严重度：** 🟡

**当前代码：**
```js
if (img && img.complete) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}
```

**问题：** `img.complete` 为 true 不代表加载成功——加载失败时 `complete` 也是 true 但 `naturalWidth` 为 0。此时 `drawImage` 会抛异常。

**优化：**
```js
if (img && img.complete && img.naturalWidth > 0) {
```

---

### OPT-07：pixivApi illust LRU 缓存每次命中都 delete+set

- **文件：** `src/pixiv-assistant/core/pixivApi.js` 第 162-163 行
- **严重度：** 🔵

**当前代码：**
```js
illustCache.delete(illustId);
illustCache.set(illustId, entry);
```

**问题：** 每次缓存命中都做 delete→set 来更新"最近访问"。两次哈希操作，且语义不清晰。

**优化：** 利用 Map 按插入顺序迭代的特性，在插入新条目时才做淘汰判断，访问命中时不重建条目。

---

## 二、错误处理（3个）

### OPT-08：useTouchGesture handleDoubleTap 无触摸事件 guard

- **文件：** `src/hooks/useTouchGesture.js` 第 394 行
- **严重度：** 🟡

**当前代码：**
```js
const touch = e.touches?.[0] || e.changedTouches?.[0] || e;
```

**问题：** 当 `e` 是非触摸事件（如键盘触发）时，`e.clientX` 不存在，导致后续 `tapX/tapY` 为 NaN，缩放动画以 NaN 为原点。

**优化：**
```js
if (!e.touches && !e.changedTouches) return;
const touch = e.touches?.[0] || e.changedTouches?.[0];
```

---

### OPT-09：useTouchGesture handleOverlayClick 穿透检查不足

- **文件：** `src/hooks/useTouchGesture.js` 第 706-712 行
- **严重度：** 🔵

**当前代码：**
```js
if (e.target === e.currentTarget) {
```

**问题：** 仅靠 target 相等判断点击的是 overlay 背景。但如果内部有透明区域或绝对定位元素未阻止冒泡，可能导致误触发。

**优化：**
```js
const handleOverlayClick = useCallback((e) => {
    if (e.target.closest('button, a, [role="button"], .lightbox-actions')) return;
    if (e.target === e.currentTarget) {
        if (Date.now() - lastTapTimeRef.current < 500) return;
        setHideUI(h => !h);
    }
}, []);
```

---

### OPT-10：pixivApi randomIllust 只有一个硬编码标签

- **文件：** `src/pixiv-assistant/core/pixivApi.js` 第 265 行
- **严重度：** 🔵

**当前代码：**
```js
const q = encodeURIComponent('10000users入り');
```

**问题：** 单一标签限制推荐范围，该标签无结果时直接返回 `{ error: 'no results' }`，无回退。

**优化：** 提供回退标签列表：
```js
const FALLBACK_TAGS = ['VOCALOID', 'オリジナル', '風景'];
```

---

## 三、内存泄漏（3个）

### OPT-11：全局 downloadCache 无 TTL

- **文件：** `src/components/FrameAnimPlayer.jsx` 第 25 行
- **严重度：** 🟡

**问题：** `downloadCache` 是模块级 Map，仅按容量淘汰（MAX=12），无基于时间的清理。长时间浏览不同作品后，blob URL 可能滞留内存直到被顶出。

**优化：** 为每个 entry 加 `lastAccess` 时间戳，配合 `setInterval` 或惰性检查清理超过 10 分钟的条目。或者改用 WeakRef（如果浏览器支持）。

---

### OPT-12：ImageDetailView 旧 blob URL 只在状态变化时回收

- **文件：** `src/components/detail/ImageDetailView.jsx` 第 243-245 行
- **严重度：** 🟡

**问题：** 组件卸载时只设置 `cancelled = true`，不回收已创建的 blob URL。连续快速切换作品时 blob URL 累积。

**优化：** 在 useEffect 清理函数中执行回收：
```js
useEffect(() => {
    let cancelled = false;
    const urls = [];
    // ... 创建 blob URL，push 到 urls
    return () => {
        cancelled = true;
        for (const u of urls) URL.revokeObjectURL(u);
    };
}, [pixivCache]);
```

---

### OPT-13：ToastHost 定时器在 unmount 时泄漏

- **文件：** `src/components/ToastHost.jsx` 第 10-12 行
- **严重度：** 🟡

**当前代码：**
```js
setTimeout(() => {
    setToasts(prev => prev.filter(t => t.id !== id));
}, 2500);
```

**问题：** 组件 unmount 时 setTimeout 仍然执行，`setToasts` 调用变为 no-op 但定时器泄漏。

**优化：** 用 ref 收集活跃的 timer ID，在 useEffect 清理函数中全部清除：
```js
const timersRef = useRef(new Set());
useEffect(() => {
    const timers = timersRef.current;
    return () => { for (const id of timers) clearTimeout(id); };
}, []);
```

---

## 四、代码重复（4个）

### OPT-14：RankingPage 未使用 useTabFeed

- **文件：** `src/pages/RankingPage.jsx` vs `src/hooks/useTabFeed.js`
- **严重度：** 🟡

**问题：** RankingPage 手动实现了缓存水合（50+ 行）、IntersectionObserver 哨兵、刷新注册——`useTabFeed` 已提供相同的功能。

**优化：** 迁移到 `useTabFeed`，利用 `hydrate`/`fetchPage` 保持 RankingPage 特有的内存缓存层和 mode 切换逻辑。

---

### OPT-15：storageService 中 5 处 GIF 回退逻辑重复

- **文件：** `src/pixiv-assistant/capacitor/storageService.js` 第 37-53、62-77、82-97、102-117、201-230 行
- **严重度：** 🟡

**问题：** `save`/`unsave`/`load`/`getState`/`saveFromNetwork` 中都有：
```js
let entity = await this.repository.find(id);
if (!entity) {
    const gifEntity = await this.repository.find(PixivEntity.makeId(illustId, 0));
    if (gifEntity?.isGif) entity = gifEntity;
}
```

**优化：**
```js
async _findEntityWithGifFallback(illustId, pageIndex) {
    let entity = await this.repository.find(PixivEntity.makeId(illustId, pageIndex));
    if (!entity && pageIndex !== 0) {
        const gifEntity = await this.repository.find(PixivEntity.makeId(illustId, 0));
        if (gifEntity?.isGif) entity = gifEntity;
    }
    return entity;
}
```

---

### OPT-16：gif.js 与 FrameAnimPlayer 双重帧缓存

- **文件：** `src/api/gif.js` 第 30-56 行 vs `src/components/FrameAnimPlayer.jsx` 第 25-47 行
- **严重度：** 🟡

**问题：** `gif.js` 有独立的 `cache` (Map, MAX=8) 和 `releaseFrames`，`FrameAnimPlayer` 有独立的 `downloadCache` (Map, MAX=12) 和 `releaseFrames`。两者功能一致但独立维护，evict 策略不同（8 vs 12）。

**优化：** 统一为一个共享帧缓存模块，导出 `getCachedFrames(illustId)` / `setCachedFrames(illustId, frames)` / `releaseFrames(frames)`。

---

### OPT-17：毛玻璃样式在 search.css 与 index.css 重复

- **文件：** `src/styles/search.css` vs `src/index.css`
- **严重度：** 🔵

**问题：** 搜索页的 `backdrop-filter: blur(24px) saturate(180%)`、`text-shadow`、`box-shadow` 组合与 index.css 的 `.frosted`、`.chip.active` 有高度相似但不统一的值。

**优化：** 定义 CSS 自定义属性统一毛玻璃参数：
```css
:root {
    --glass-blur: 12px;
    --glass-blur-strong: 24px;
    --glass-saturate: 180%;
}
```

---

## 五、API 调用（3个）

### OPT-18：searchPixiv 无 AbortController

- **文件：** `src/pixiv-assistant/core/pixivApi.js` 第 176-192 行
- **严重度：** 🟡

**问题：** 用户快速输入搜索词时，前一次请求不会被取消。虽然后端通常按序响应，但弱网下旧响应可能覆盖新搜索结果。

**优化：** 搜索函数接受 `AbortSignal`，SearchPage 在发起新搜索前 abort 旧请求：
```js
const abortRef = useRef(null);
const runSearch = useCallback((q) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    pixivApi.searchPixiv(q, { signal: controller.signal });
}, []);
```

---

### OPT-19：fetchIllust 缓存不区分 404

- **文件：** `src/pixiv-assistant/core/pixivApi.js` 第 217-262 行
- **严重度：** 🔵

**问题：** 5 分钟 TTL 对所有响应一视同仁。如果作品被删除，缓存仍保留 5 分钟的旧数据。

**优化：** 对 404/403 使用更短 TTL（如 30 秒），或根本不缓存错误响应。

---

### OPT-20：fetchUserIllusts 使用 profile/top 而非 profile/all

- **文件：** `src/pixiv-assistant/core/pixivApi.js` 第 338-341 行
- **严重度：** 🔵

**问题：** `profile/top` 仅返回近期作品（约 20-30 件），`profile/all` 返回全部作品 ID。如果用户想看该作者的早期作品，当前实现无法满足。注释说 `profile/all` 返回的缩略图不可用，但可以通过 `pixivReUrl` 构造 URL。

**优化：** 先用 `profile/all` 获取作品 ID 列表，再用 `pixivReUrl` 构造缩略图 URL，分页返回。

---

## 六、状态管理（3个）

### OPT-21：useAppStore openDetail 在 store 中查询 DOM

- **文件：** `src/store/useAppStore.js` 第 69-76 行
- **严重度：** 🔴

**当前代码：**
```js
openDetail: (img) => {
    const el = document.querySelector('.app-content');
    if (el) {
        set({ scrollPositions: { ...scrollPositions, [activeTab]: el.scrollTop } });
    }
    set({ detailImage: img });
},
```

**问题：** Zustand store 中直接查询 DOM 打破 store 应为纯状态的规则，同时不可测试。

**优化：** DOM 滚动值由 App 组件在调用前读取，作为参数传入：
```js
// App.jsx
const handleOpenDetail = (img) => {
    const el = document.querySelector('.app-content');
    openDetail(img, el?.scrollTop ?? 0);
};
// useAppStore
openDetail: (img, scrollTop) => set({ scrollPositions: {...}, detailImage: img }),
```

---

### OPT-22：openAuthorImage 嵌套 set+get 依赖 Zustand 同步 set

- **文件：** `src/store/useAppStore.js` 第 96-112 行
- **严重度：** 🔵

**当前代码：**
```js
openAuthorImage: (item) => {
    const { authorWorks } = get();
    set({ authorWorks: null });
    get().openDetail({ ... });  // 依赖 set 是同步的
},
```

**问题：** `set` 后立即 `get().openDetail()`，依赖 Zustand 同步更新的实现细节。

**优化：** 直接在 action 内构造 detailImage 并 set：
```js
openAuthorImage: (item) => {
    const { authorWorks } = get();
    set({
        authorWorks: null,
        detailImage: { illustId: item.illustId, ... }
    });
},
```

---

### OPT-23：LightboxActions longPressTriggeredRef 依赖事件顺序

- **文件：** `src/components/LightboxActions.jsx` 第 66-72 行
- **严重度：** 🟡

**问题：** `longPressTriggeredRef` 依赖 `pointerup` 在 `click` 之前触发。不同浏览器/设备的事件顺序可能不同（iOS Safari 与 Android Chrome 不同）。

**优化：** 使用 `onPointerUp` 替代 `onClick`，或在 `click` handler 中检查时间戳而非依赖 ref 标志。

---

## 七、CSS（4个）

### OPT-24：index.css 两个 :root 块

- **文件：** `src/index.css` 第 1-12 行 + 第 15-36 行
- **严重度：** 🔵

**问题：** 两个独立的 `:root` 块，第二个主要是别名映射。部分别名（如 `--color-primary: var(--accent)`）如果代码中无人引用可直接删除。

**优化：** 合并为单个 `:root` 块，删除未使用的别名。

---

### OPT-25：lightbox.css !important 滥用

- **文件：** `src/styles/lightbox.css` 第 144 行
- **严重度：** 🟡

**当前代码：**
```css
.lightbox-slide { opacity: 1 !important; }
```

**问题：** `!important` 用于覆盖手势操作时的 inline opacity。如果手势代码正确设置了最终值，不需要 `!important`。

**优化：** 确保手势操作结束时显式设置 `el.style.opacity = ''`（而非保留中间态），然后移除 `!important`。

---

### OPT-26：detail.css object-fit: initial 非标准

- **文件：** `src/styles/detail.css` 第 260 行
- **严重度：** 🔵

**问题：** `object-fit: initial` 是无效值，应该用 `unset` 或 `fill`。浏览器可能静默忽略。

**优化：** 改为 `object-fit: fill`（或 `contain`/`cover`，根据实际意图）。

---

### OPT-27：字号 9px 低于可读性阈值

- **文件：** `src/index.css` 第 394 行
- **严重度：** 🔵

**当前代码：**
```css
.chips-bottom .chip--small { font-size: 9px; }
```

**问题：** 9px 在部分浏览器会被强制放大到 12px（minimum font size），导致布局错位。移动端几乎不可读。

**优化：** 改为 `font-size: 10px`（最小安全值），配合 `transform: scale(0.9)` 如果需要保持"小"的视觉效果。

---

## 八、可访问性（3个）

### OPT-28：移动端灯箱隐藏导航按钮无替代方案

- **文件：** `src/styles/lightbox.css` 第 281-286 行
- **严重度：** 🟡

**问题：** `@media (max-width: 768px) { .lightbox-nav { display: none; } }` 移动端完全依赖手势滑动，屏幕阅读器用户或运动障碍用户无法翻页。

**优化：** 即使缩小，也保留语义按钮（可在视觉上缩小到 24x24 而非完全隐藏），或添加底部指示器可点击。

---

### OPT-29：FrameAnimPlayer Canvas 无 aria-label

- **文件：** `src/components/FrameAnimPlayer.jsx` 第 456 行
- **严重度：** 🔵

**问题：** Canvas 无 `role="img"` 或 `aria-label`，屏幕阅读器无法描述内容。

**优化：**
```jsx
<canvas role="img" aria-label={title || '动画'} ref={canvasRef} ... />
```

---

### OPT-30：SearchPage 搜索框 placeholder 为空

- **文件：** `src/pages/SearchPage.jsx` 第 153 行
- **严重度：** 🔵

**问题：** `placeholder=""` 用户看不到输入提示。

**优化：** `placeholder="搜索 Pixiv 作品"`

---

## 九、安全性（2个）

### OPT-31：CustomEvent 无来源验证

- **文件：** `src/components/LightboxActions.jsx` 第 29 行
- **严重度：** 🟡

**当前代码：**
```js
window.dispatchEvent(new CustomEvent('pixiv:liked-changed'));
```

**问题：** 任何脚本可触发此事件。虽在 WebView 中风险低，但在浏览器调试中可能被利用。

**优化：** 改用 Zustand store 的订阅机制，或至少在事件 detail 中加入来源校验 token。

---

### OPT-32：日志可能泄露 Cookie

- **文件：** `src/pixiv-assistant/core/pixivApi.js` 第 140-145 行
- **严重度：** 🟡

**问题：** `transport.getCookie()` 返回的完整 cookie 在各 API 函数中直接放入 headers。如果错误日志打印了请求详情，cookie 可能泄露。

**优化：** 在 logger 中添加 cookie header 脱敏过滤器：
```js
// logger.js
function sanitizeCookie(str) {
    return str.replace(/PHPSESSID=[^;]+/, 'PHPSESSID=***');
}
```

---

## 十、健壮性（3个）

### OPT-33：useTouchGesture findAdjacentPage 依赖数组包含整个 images

- **文件：** `src/hooks/useTouchGesture.js` 第 322 行
- **严重度：** 🔵

**当前代码：**
```js
const findAdjacentPage = useCallback((dir) => { ... }, [cur, images]);
```

**问题：** 依赖整个 `images` 数组意味着每次 images 浅引用变化时 `findAdjacentPage` 重建。

**优化：** 改为 `[cur?.illustId, cur?._totalPages, images.length]`。

---

### OPT-34：useTabFeed IntersectionObserver 依赖 load 导致频繁重建

- **文件：** `src/hooks/useTabFeed.js` 第 145-156 行
- **严重度：** 🟡

**问题：** IntersectionObserver 的 useEffect 依赖 `[hasMore, loading, loadingMore, load]`，`load` 引用变化时重建 observer。

**优化：** 用 ref 存储最新 load：
```js
const loadRef = useRef(load);
loadRef.current = load;
// 回调中: loadRef.current(true)
// 依赖: [hasMore, loading, loadingMore]  // 不需要 load
```

---

### OPT-35：useTabFeed rootMargin 硬编码

- **文件：** `src/hooks/useTabFeed.js` 第 153 行
- **严重度：** 🔵

**当前代码：**
```js
{ rootMargin: '200px 0px' }
```

**问题：** 200px 硬编码，不同屏幕尺寸下效果不同。

**优化：**
```js
const rootMargin = useMemo(
    () => `${Math.round(window.innerHeight * 0.3)}px 0px`,
    []
);
```

---

## 汇总

| 类别 | 数量 | 🔴严重 | 🟡中度 | 🔵轻度 |
|------|------|--------|--------|--------|
| 性能 | 7 | 1 | 3 | 3 |
| 错误处理 | 3 | 0 | 1 | 2 |
| 内存泄漏 | 3 | 0 | 3 | 0 |
| 代码重复 | 4 | 0 | 3 | 1 |
| API 调用 | 3 | 0 | 1 | 2 |
| 状态管理 | 3 | 1 | 1 | 1 |
| CSS | 4 | 0 | 1 | 3 |
| 可访问性 | 3 | 0 | 1 | 2 |
| 安全性 | 2 | 0 | 2 | 0 |
| 健壮性 | 3 | 0 | 1 | 2 |
| **合计** | **35** | **2** | **17** | **16** |

**2 个严重问题：**
- OPT-21：Store 中直接 DOM 查询
- OPT-04：cacheDB IIFE 阻塞首次加载

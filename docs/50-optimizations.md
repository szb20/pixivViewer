# pixivViewer 优化点审查报告

> 日期：2026-08-05 | 基于当前 HEAD（7986a2c）逐条核对

---

## 总览

本次审查覆盖 50 个条目，经与当前代码逐条对照后：

| 结论 | 数量 | 说明 |
|------|------|------|
| ✅ 真问题，值得修 | ~22 | 有效发现 |
| ⚠️ 假阳性 / 已修复 | 4 | OPT-15、OPT-29、OPT-26、OPT-07 |
| 🔶 机制描述有误 | 2 | OPT-32、OPT-45 |
| 🔷 建议本身有问题 | 2 | OPT-08（会破坏 LRU）、OPT-03（设计取舍） |
| 💤 微优化，价值低 | ~10 | 做了不坏但不做也没事 |

**严重度校准后**：🔴 真正严重 1 个 → 🟡 中等 12–15 个 → 🔵 轻度 20+ 个

---

## 优先级：现在就该修

### P0 — OPT-28：storageService.saveFromNetwork 中 clearInterval(rampTimer) 是死代码 🔴

- **文件：** `src/pixiv-assistant/capacitor/storageService.js` 第 344 行
- **状态：** ✅ 真 bug。`rampTimer` 是 `NetworkStore.downloadImage()` 的局部变量，ES module 严格模式下此处抛 `ReferenceError`，且发生在 catch 块内——外层 catch 会捕获 ReferenceError 而非原始错误，`mon.finish` 和 `throw e` 都不会执行。
- **修复：** 删除该行。`NetworkStore` 已在 `try/finally` 中正确清理（见当前代码 networkStore.js:53-54）。

### P1 — OPT-25：搜索竞态——比描述的更糟 🟡

- **文件：** `src/pixiv-assistant/core/pixivApi.js` + `src/hooks/useTabFeed.js`
- **状态：** ✅ 真问题，但实际竞态比文档描述的严重。`useTabFeed.load` 以 `if (loadingRef.current) return` 守卫，快速连搜时**新搜索被静默丢弃**（不是"旧响应覆盖"）。加 AbortController 只能解决网络层，更关键的是让加载中换词时**强制替换**而非跳过。
- **修复：** 两处改动：(1) `searchPixiv` 接受 `AbortSignal`；(2) `useTabFeed` 中加载中换词时 abort 旧请求并用 ref 标记"新搜索来了"，在 then 回调中丢弃旧结果。

### P2 — OPT-17：blob URL 卸载/切换时不回收 🟡

- **文件：** `src/components/detail/ImageDetailView.jsx`
- **状态：** ✅ 真问题。blob effect（276–303 行）cleanup 只设 `cancelled`；reset effect（195 行）直接 `prevLocalSrcsRef.current = {}` 丢弃旧引用。切作品时旧 blob URL 确实不回收，会累积。注意文档引用行号（243–245）对错了地方——那是 fetchIllust 的 effect。
- **修复：** 在 blob effect 的 cleanup 中回收已创建的 URL；在 reset effect 中对 `prevLocalSrcsRef.current` 的旧值做 `URL.revokeObjectURL`。

---

## 优先级：值得做

### P3 — OPT-11：cacheDB IIFE（描述部分夸大）🟡

- **文件：** `src/pixiv-assistant/capacitor/cacheDB.js` 第 564-590 行
- **状态：** ⚠️ 方向对，但"每次页面加载都执行"错误（SPA 模块只加载一次），"阻塞首次加载"夸大（异步 IIFE 不阻塞首帧渲染，只是可能和并发 DB 操作串行）。真实影响：启动时一次全表 readwrite 事务，大数据集时占用 IndexedDB store。
- **修复：** 加 `localStorage` 标记改成单次迁移，或移到 DB `onupgradeneeded`。

### P4 — OPT-30：Store 中 DOM 查询 🟡

- **文件：** `src/store/useAppStore.js`
- **状态：** ✅ 属实，不止 `openDetail`——`setActiveTab`(22 行)、`closeDetail`(82 行) 也查 DOM。功能正常，纯架构/可测性问题。🟡 合适，不是 🔴。
- **修复：** DOM 滚动值由 App 组件读取后作为参数传入 store action。

### P5 — OPT-19：Capacitor backButton 异步 import 竞态 🟡

- **文件：** `src/App.jsx` 第 53-72 行
- **状态：** ✅ 属实。StrictMode 双挂载或极快卸载场景下 listener 泄漏。生产环境基本无感。
- **修复：** 加 `cancelled` 标志。

### P6 — OPT-22：gif.js 与 FrameAnimPlayer 双重帧缓存 🟡

- **文件：** `src/api/gif.js` + `src/components/FrameAnimPlayer.jsx`
- **状态：** ✅ 属实。两个独立缓存（MAX=8 vs MAX=12），各自 evict 时释放 blob URL，可能互相把对方缓存的 blob 释放掉。合并有真实价值。
- **修复：** 抽共享帧缓存模块。

### P7 — OPT-50：DiscoverPage 生产代码 log.warn 调试日志 🔵

- **文件：** `src/pages/DiscoverPage.jsx` 第 34 行
- **状态：** ✅ 属实。一行改动，零风险。
- **修复：** `log.warn` → `log.debug`。

---

## 假阳性 / 已修复 / 应移除

### ~~OPT-15（🔴）：useTabFeed loadingRef 永为 true~~ ❌ 假阳性

- **当前代码（第 70-92 行）：**
  ```js
  try {
      const r = await fetchPageStable(append, itemsRef.current);
      if (r == null) {
          log.debug('[load] fetchPage 返回 null，跳过');
          return;
      }
      // ...
  } catch (e) { ... }
  finally {
      setLoading(false);
      setLoadingMore(false);
      loadingRef.current = false;   // ← 一定会执行
  }
  ```
- **结论：** `r == null` 返回在 `try` 块内，`finally` 保证 `loadingRef.current` 被重置。这条应直接划掉。

### ~~OPT-29（🟡）：NetworkStore rampTimer 无清理~~ ❌ 已修复

- **当前代码（networkStore.js 第 51-54 行）：**
  ```js
  try {
      return await this._downloadWithCapacitor(url);
  } finally {
      clearInterval(rampTimer);  // ← 已加 finally 兜底
  }
  ```
- **结论：** 已修复。这条和 OPT-28 是同一个 bug 的两面——OPT-28 对（storageService 死代码）、OPT-29 已不成立。

### ~~OPT-26（🔵）：fetchIllust 404 缓存 TTL~~ ❌ 机制不存在

- **实际行为：** `fetchIllust` 只在成功时 `setCachedIllust`，错误/404 走 catch 返回，从不缓存。不存在"404 缓存 5 分钟"。残留的只是"成功缓存 5 分钟内作品被删除"这种任何 TTL 缓存都有的固有场景。
- **结论：** 移除。

### ~~OPT-07（🟡）：FrameAnimPlayer img.complete 不充分~~ ❌ 不成立

- **实际行为：** 加载失败的帧不会被 push 进 `images[]`（只有 `onload` 才 `images[i] = img`），失败帧的 `img` 是 `undefined`。`if (img && img.complete)` 已跳过 `drawImage`。加 `naturalWidth` 是锦上添花的防御性写法，不是修崩溃。
- **结论：** 降为 🔵，标注"可选防御性加固"。

---

## 机制描述有误

### OPT-32（🟡）：likeMeta 因触摸移动重建

- **实际行为：** `cur = images[index]`（useTouchGesture 33 行），触摸移动只改 `swipeOff`/`pinchScale` 等 state，`index` 和 `images` 引用都不变，`cur` 引用稳定。`likeMeta` 不会因触摸移动重建。
- **根因：** 这其实是 OPT-05（lightboxMedia IIFE 导致 items 数组引用每次变）的下游表现。两条应合并。

### OPT-45（🟡）：日志泄露 Cookie

- **实际行为：** transport（devFetch/prodFetch）只 log `pathname` 和 `e.message`，从不打印 headers。cookie 目前没有泄漏途径。
- **结论：** 纯预防性加固，🟡 偏高，降 🔵。

---

## 建议本身有问题

### OPT-08：命中时不 delete+set ❌

- **建议"访问命中时不重建条目"会破坏 LRU 语义**（退化成 FIFO）。`delete → set` 把条目移到 Map 尾部正是实现 Map LRU 的标准做法。**不要改。**

### OPT-03：仅挂载当前 tab ❌

- `display:none` 保活是**刻意为之**——切 tab 后回来，搜索词、滚动位置、已加载的 feed 都在。改为条件卸载需要把所有 tab 状态整体上提到 App 层或 store，是有明显代价的设计取舍，不是无脑修。

---

## 微优化（价值低，做了不坏不做也没事）

以下条目技术上成立但实际影响极小，属于"有追求可以顺手做"的范畴：

- **OPT-01** — useTouchGesture 返回值 useMemo。MediaLightbox 解构使用，对象身份变化不会直接导致子组件重渲染
- **OPT-02** — App.jsx 内联 style。5 个 `{ display: ... }` 对象的创建开销可以忽略
- **OPT-04** — ImageDetailView Array.from useMemo。DetailPageBlock 有稳定 key，不会因为数组引用变化而全部重渲染
- **OPT-09** — PixivCacheProvider 全量迭代。O(n) over 几百条可以忽略，ref 检查已阻止下游渲染
- **OPT-18** — ToastHost 定时器。unmount 后 `setToasts` 是 no-op，不泄漏内存（timer 被 GC）
- **OPT-24** — 两个页面重复 scroll 监听。功能正常，低优先级
- **OPT-35** — :root 块合并。纯 cosmetic
- **OPT-38** — 9px 字号。实际渲染没问题，极低优先级
- **OPT-43** — MediaLightbox index key。items 数组不会被重排，用 index 无实际 bug
- **OPT-49** — DetailPageBlock src 作 key。localSrcs 从 null 变 blob URL 时重新挂载反而确保新 blob 被正确渲染

---

## 汇总

### 按优先级

| 优先级 | 数量 | 条目 |
|--------|------|------|
| P0 现在修 | 1 | OPT-28 |
| P1 尽快修 | 2 | OPT-17、OPT-25 |
| P2 值得做 | 5 | OPT-11、OPT-19、OPT-22、OPT-30、OPT-50 |
| P3 可做 | ~12 | OPT-01、OPT-02、OPT-04、OPT-05、OPT-09、OPT-10、OPT-12、OPT-13、OPT-14、OPT-16、OPT-18、OPT-20、OPT-21、OPT-23、OPT-24、OPT-31、OPT-33、OPT-34、OPT-35、OPT-36、OPT-37、OPT-38、OPT-39、OPT-40、OPT-41、OPT-42、OPT-43、OPT-44、OPT-46、OPT-47、OPT-48、OPT-49 |
| 划掉 | 6 | OPT-15、OPT-29、OPT-26、OPT-07、OPT-08、OPT-03 |

### 严重度（校准后）

| 等级 | 数量 | 条目 |
|------|------|------|
| 🔴 严重 | 1 | OPT-28 |
| 🟡 中等 | ~13 | OPT-05、OPT-11、OPT-17、OPT-19、OPT-21、OPT-22、OPT-24、OPT-25、OPT-30、OPT-33、OPT-34、OPT-36、OPT-47 |
| 🔵 轻度 | ~20 | 其余 |
| ❌ 移除 | ~10 | 假阳性/已修复/建议错误 |

### 原 6 个 🔴 的复核结论

| 条目 | 原严重度 | 复核 | 结论 |
|------|---------|------|------|
| OPT-03 | 🔴 | 🟡 | 设计取舍，非 bug |
| OPT-06 | 🔴 | 🔵 | reset effect 已 cover 主路径 |
| OPT-11 | 🔴 | 🟡 | 夸大描述，实际影响有限 |
| OPT-15 | 🔴 | ❌ | 假阳性，finally 保证清理 |
| OPT-28 | 🔴 | 🔴 | **唯一名副其实的严重问题** |
| OPT-30 | 🔴 | 🟡 | 架构问题非 bug，功能正常 |

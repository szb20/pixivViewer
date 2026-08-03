# 保存逻辑重构方案

> 撰写日期：2026-08-03
> 相关文件：`src/components/detail/ImageDetailView.jsx`、`src/pixiv-assistant/capacitor/storageFacade.js`、`src/pixiv-assistant/capacitor/storageService.js`

---

## 一、现状问题

### 1.1 两条并行的保存路径，逻辑重复

```
路径A: savePage(page)                    路径B: handleSaveAllOnLike
  ├─ 去重: autoSavedKeysRef                ├─ 去重: pixivCache[ck]?.saved
  ├─ URL拼装: pg.originalUrl || ...        ├─ URL拼装: pg.originalUrl || derived || ...
  ├─ 调用 saveFromNetwork                  ├─ 调用 saveFromNetwork
  └─ GIF兜底: 自己写一遍                   └─ GIF兜底: 又自己写一遍
```

### 1.2 GIF 兜底散落在 3 个地方

- `savePage()` 里有一段 `if (r?.error === 'gif_not_supported')` 回退
- `handleSaveAllOnLike()` 里有一段完全相同的回退
- `window.api.cachePixivImage()` 里也有一段判断

实际上应该统一在 `storageFacade` 层处理。

### 1.3 灯箱打开时 GIF 不保存

GIF 走 `<UgoiraPlayer/>` 分支，不经过 `DetailPageBlock`，`handleLightboxOpen` 对它无效。

### 1.4 多图并发爆炸

如果作品 20 页，进入灯箱时 `handleLightboxOpen` 同步启动 20 个 `savePage`，没有并发控制。

---

## 二、重构目标

1. **一条保存链路** — 所有场景走同一个入口，消除重复逻辑
2. **GIF 在 storageFacade 层统一处理** — 调用方无需关心动图/静图的差异
3. **统一去重机制** — 合并 `autoSavedKeysRef` 和 `pixivCache` 两套去重
4. **分批并发控制** — 多图保存时最多 3 页并发，避免请求爆炸
5. **清晰的职责划分** — DetailPageBlock 只负责显示，保存逻辑全部在 ImageDetailView 层

---

## 三、方案设计

### 3.1 核心架构

```
                    ┌──────────────────────────────┐
                    │  storageFacade               │
                    │  saveFromNetwork(item)        │ ← 内部自动处理 GIF
                    │    ① 静态图 → downloadImage  │
                    │    ② GIF → saveGifToAlbum    │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────┐
                    │  ImageDetailView     │
                    │  saveAllPages()      │ ← 统一保存函数，入口1/2/3共用
                    │  savePage()          │ ← 保存单页，内部去重
                    └──────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
   入口1: 进入详情         入口2: 点击灯箱      入口3: 点击❤️
   (单图自动保存)         (保存全部页)         (保存全部页)
```

### 3.2 统一保存函数

```js
// === 单页保存（内部去重） ===
const savePage = useCallback(async (page) => {
  // 去重：autoSavedKeysRef（本次会话）
  // 构造 item 对象
  // 调用 storageFacade.saveFromNetwork(item)
  // 成功 → 更新 pixivCache
  // 失败 → 释放 key 以便重试
}, [...]);

// === 全部页保存（分批并发） ===
const saveAllPages = useCallback(async (options = {}) => {
  // 跳过已保存的页（pixivCache）
  // 分批，每批最多 3 页并发
  // 全部静默（不弹 toast）
  // 返回保存结果列表
}, [...]);
```

### 3.3 storageFacade 统一处理 GIF

```js
// 改造前：
async saveFromNetwork(item) {
  if (item.type === 'gif') return { success: false, error: 'gif_not_supported' };
  // ... 静态图下载 ...
}

// 改造后：
async saveFromNetwork(item) {
  if (item.type === 'gif' || Number(item.illustType) === 2) {
    return await saveGifToAlbum(item);  // 内部处理
  }
  // ... 静态图下载 ...
}
```

### 3.4 DetailPageBlock 职责简化

```jsx
// DetailPageBlock 不再接收 onSavePage prop
// 只做：进入视口 → 懒加载原图用于显示（本地相册优先 → 网络原图）
// 保存逻辑全在 ImageDetailView 层控制
```

### 3.5 单图自动保存上移到 ImageDetailView

```js
// illustData 就绪后，单图作品自动保存一次
useEffect(() => {
  if (pageCount <= 1 && illustData && !autoSavedKeysRef.current.has(`${image.illustId}_0`)) {
    savePage(0);
  }
}, [pageCount, illustData, image?.illustId]);
```

---

## 四、行为矩阵

| 场景 | 单图 | 多图 | GIF |
|------|------|------|-----|
| 进入详情页（illustData 就绪后） | ✅ 自动保存 1 次 | ❌ 不保存 | ✅ 自动保存 1 次 |
| 点击进入灯箱 | ✅ 保存（走 savePage） | ✅ 保存全部页（分批 3 并发） | ✅ 保存（走 savePage） |
| 点击 ❤️ 喜欢 | ✅ 保存全部页 | ✅ 保存全部页（分批 3 并发） | ✅ 保存全部页 |

---

## 五、需要修改的文件

| 文件 | 修改内容 |
|------|---------|
| `src/components/detail/ImageDetailView.jsx` | 核心改动：删 `DetailPageBlock.onSavePage`、删 `handleSaveAllOnLike`、新增 `saveAllPages`、单图自动保存上移 |
| `src/pixiv-assistant/capacitor/storageFacade.js` | 让 `saveFromNetwork` 内部处理 GIF，不再返回 `gif_not_supported` |
| `src/pixiv-assistant/capacitor/storageService.js` | 移除 `saveFromNetwork` 中的 `if (type === 'gif') return error` 判断 |
| `src/api/index.js` | 清理 `cachePixivImage` 中的 GIF 判断（如果 `storageFacade` 已处理则简化） |

### 5.1 可删除的代码

| 删除项 | 位置 | 说明 |
|--------|------|------|
| `DetailPageBlock` 的 `onSavePage` prop | `ImageDetailView.jsx` | 不再需要 |
| `DetailPageBlock` 内 `if (!saved) { onSavePage?.(page) }` | 同上 | 不再需要 |
| `handleSaveAllOnLike` 函数 | 同上 | 合并到 `saveAllPages` |
| `savePage` 里的 GIF 兜底 `if (r?.error === 'gif_not_supported')` | 同上 | 移到 `storageFacade` |
| `handleSaveAllOnLike` 里的 GIF 兜底 | 同上 | 同上 |
| `storageService.saveFromNetwork` 的 `if (type === 'gif') return error` | `storageService.js` | 不再需要 |
| `window.api.cachePixivImage` 中的 GIF 分支 | `api/index.js` | 如果 `storageFacade` 已处理 |

---

## 六、实施步骤

1. **改造 `storageFacade.saveFromNetwork`** — 内部处理 GIF，调用方无需兜底
2. **改造 `storageService.saveFromNetwork`** — 移除 `gif_not_supported` 返回
3. **改造 `api/index.js`** — 简化 `cachePixivImage`
4. **改造 `ImageDetailView.jsx`**：
   - 新增 `saveAllPages`（分批并发）
   - 删除 `handleSaveAllOnLike`，`handleSaveAllOnLike` 改用 `saveAllPages`
   - 删除 `DetailPageBlock.onSavePage` prop
   - 单图自动保存上移为 `useEffect`
   - 清理所有 GIF 兜底代码
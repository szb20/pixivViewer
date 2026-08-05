# 数据库迁移清理方案

## 目标

将 `cacheDB.js` 中 v1→v10 的历史迁移代码全部移除，使 IndexedDB 初始化和 schema 回归简洁。

## 原理

当前所有用户的数据库都已完成 v1→v10 的迁移，迁移代码只对「第一次打开数据库时还没有执行过对应版本升级」的场景有意义，而这一天早已过去。

老用户升级时，数据库名变更会使旧数据库被忽略，应用自动创建新数据库。喜欢/已保存数据通过 `pixiv_meta.json` 备份恢复（`metaBackup.js` 已有完备的导出/恢复逻辑）。自动缓存的临时数据丢失无影响，浏览时自然重建。

## 变更清单

### 1. `src/pixiv-assistant/capacitor/cacheDB.js`

#### 1.1 数据库改名 + 版本回归

```
DB_NAME  = 'teyvat_pixiv_cache'  →  'teyvat_pixiv_cache_v2'
DB_VERSION = 10                  →  1
```

旧数据库 `teyvat_pixiv_cache` 留在浏览器存储中，不会自动删除（IndexedDB 没有跨库删除 API），但也不再被引用。用户清理浏览器数据时会一并清理。

#### 1.2 `openDB()` 精简

`onupgradeneeded` 只保留建 store + 建索引（这是 v1 的创建逻辑），删除所有 `if (e.oldVersion < N)` 迁移块。

最终 `onupgradeneeded` 内容：

```js
req.onupgradeneeded = () => {
  const db = req.result;
  const store = db.createObjectStore(STORE, { keyPath: 'cacheKey' });
  store.createIndex('illustId', 'illustId', { unique: false });
  store.createIndex('cachedAt', 'cachedAt', { unique: false });
  store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
  store.createIndex('author', 'author', { unique: false });
  store.createIndex('state', 'state', { unique: false });
  store.createIndex('stateCachedAt', ['state', 'cachedAt'], { unique: false });
  store.createIndex('likedAt', 'likedAt', { unique: false });
};
```

#### 1.3 删除兼容代码

- `getByStatePaginated()` 中 fallback 到 `saved` 字段的兼容分支（`!r.state && ...`）→ 删除，只保留 `r.state === filterState`
- `getCacheStats()` 中 `auto` 字段改为 `cached`

#### 1.4 删除 `cleanTitles()` IIFE

模块末尾的标题清理 IIFE 是一次性脚本，已完成使命，直接删除。

### 2. `src/pixiv-assistant/capacitor/entity.js`

#### 2.1 `fromRecord()` 精简

删除兼容逻辑：

- ~~`saved: 0|1 → state` 推导~~ → 所有新记录都有 `state`
- ~~`cacheKey` 后缀推断 `type`~~ → 所有新记录都有 `type`
- ~~`cacheKey` 无 `:` 时用 `makeId` 生成 id~~ → 所有新记录都用 `pixiv:...` 格式

最终 `fromRecord()` 变为纯映射：

```js
static fromRecord(record) {
  if (!record) return null;
  return new PixivEntity({
    id: record.cacheKey,
    illustId: record.illustId,
    pageIndex: record.pageIndex ?? 0,
    type: record.type || 'image',
    state: record.state || 'cached',
    flags: record.flags || {},
    // ... 其余字段直映射
  });
}
```

### 3. `src/pixiv-assistant/capacitor/repository.js`

#### 3.1 `find()` 删除旧 key 兼容查找

移除对 `pixiv_{id}_{page}` / `pixiv_{id}_g0` / `pixiv_{id}` 三种旧格式的 fallback 查找逻辑。新数据库只存 `pixiv:...` 格式。

#### 3.2 `changeState()` 删除 `saved` 兼容字段写入

```js
// 删除这行（旧代码兼容）
record.saved = newState === 'saved' ? 1 : 0;
```

### 4. 不需要改的文件

| 文件 | 原因 |
|---|---|
| `metaBackup.js` | 备份/恢复/对账逻辑与新数据库完全兼容，不需改动 |
| `tabCache.js` | 独立数据库，不受影响 |
| `PixivCacheProvider.jsx` | 启动流程不变，只是调用的底层服务换了数据库名 |
| `storageService.js` / `storageFacade.js` | 业务编排层，不感知底层存储细节 |
| `entity.js` 的 `toRecord()` | 输出格式本身就没旧字段 |
| UI 组件 | 不直接接触 IndexedDB |

### 5. `getCacheStats()` 字段改名

`{ total, saved, auto, totalSize }` → `{ total, saved, cached, totalSize }`

`auto` 改为 `cached`，语义更准确。检查调用方：

- `repository.js` 的 `stats()` 直接透传返回值
- `storageService.js` 的 `stats()` 直接透传
- `storageFacade` 没有暴露 stats 方法

无外部调用者通过解构使用 `auto` 字段，改名安全。

### 6. 保留的字段

`entity.toRecord()` 和 `entity.fromRecord()` 中继续保留 `flags` 对象（含 `favorite`、`syncing`、`broken`、`cloud`）。虽然当前 `favorite` 已被 `likedAt` 取代，但 `flags` 是预留扩展点，不影响简洁性。

## 执行顺序

1. `cacheDB.js` — 改数据库名、版本号、精简 `onupgradeneeded`、删兼容分支、删 `cleanTitles` IIFE
2. `entity.js` — 精简 `fromRecord()`
3. `repository.js` — 精简 `find()`、`changeState()`
4. 构建测试 APK，验证新安装和升级场景

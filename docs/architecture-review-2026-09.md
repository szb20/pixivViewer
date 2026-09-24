# pixivViewer 架构审查报告

> 审查日期：2026-09-24 · 审查范围：src/ + electron/ + scripts/（约 16,800 行）· HEAD: e99cfdf
>
> 本文件用于外部评审（提交给 GPT 等模型评估），因此尽量自包含：所有结论均附 `文件:行号` 证据，
> 未直接验证的项已标注「未验证」。文件路径均相对于项目根目录。

---

## 〇、项目背景（供无仓库访问权的评审者参考）

| 维度 | 现状 |
|------|------|
| 定位 | Pixiv 图片浏览 / 下载应用，个人自用（单开发者） |
| 前端 | React 19 + Vite 8，`.jsx` + JSDoc 类型标注（**非 TypeScript**） |
| 状态 | zustand 5 + 2 个 React Context |
| 路由 | 依赖 react-router-dom 7，但实际是自研 Tab 切换 |
| 存储 | IndexedDB（元数据）+ Capacitor Filesystem（文件）+ Android MediaStore（相册） |
| 目标平台 | Android（Capacitor 8，主平台）、Electron 33（桌面）、浏览器（Vite dev） |
| 规模 | src/ 约 70 个 JS/JSX 文件；存储层 13 个文件 2,888 行；CSS 7 个文件 3,709 行 |
| 提交数 | 63 |
| 文档 | `docs/architecture.md` + `docs/archive/` 下 10 份历史评审（合计 4,659 行，写于 2026-08-03 ~ 08-05） |

**声称的分层**（`docs/architecture.md`）：

```
表现层 (App / Pages / Components / Hooks / Styles)
  ↓
API 层 (api/pixiv.js 传输适配 / api/gif.js 动图 / api/index.js 统一保存入口)
  ↓
业务核心层 (pixiv-assistant/core/ — 声称"纯逻辑、无平台依赖、可复用")
  ↓
存储层 (pixiv-assistant/capacitor/ — Facade → Service → TransitionEngine → Repository/FileStore → cacheDB/NetworkStore)
  ↓
工具层 (utils/)
```

---

## 一、审查方法与验证手段

- 完整读取：存储层全部 13 个文件、`core/pixivApi.js`、`api/pixiv.js`、`entity.js`、`transitionEngine.js`、`storageService.js`、`storageFacade.js`、`fileStore.js` 关键段
- 对**每一个 export 做全仓库消费方 grep**，逐个确认死代码（含相对路径与 JSDoc 引用形式）
- 对每个"分层违规"追到实际调用点，而非只看 import 语句
- 对可疑的运行时行为（如状态机可达性）追完整调用链确认是否可达
- **用 Node v24 实际 import core/ 的模块**，验证"无平台依赖"的声称（见 S4）——这是唯一一处非静态分析的验证
- `git log --name-only` 统计变更频率，定位摩擦集中点
- 交叉核对 `docs/architecture.md` 的声称与代码实现

**结论摘要**：分层意识强，但**抽象密度超过了问题本身的复杂度**，且多处抽象已与现实脱节。核心问题不是"不够优雅"，而是**过度设计 + 抽象漂移**，建议方向是**删除约 750 行**而非新增层次。

---

## 二、严重问题

### S1. 桌面端（Electron）的原生能力桥从未实现，约 160 行死代码

项目里并存**两套互不相容的桌面桥设计**：

| 桥名 | 使用方 | 是否真实存在 |
|------|--------|--------------|
| `window.desktop`（要求 `.platform === 'electron'`，方法 `fs` / `download` / `http` / `gallery`） | `src/utils/platform.js:14`、`src/utils/desktopFs.js:51`、`src/utils/desktopDownload.js:29-35`、`src/api/gif.js:484` | **不存在** |
| `window.desktopProxy`（方法 `getPort` / `saveFile` / `chooseDirectory`） | `src/api/pixiv.js:18`、`src/pages/SettingsPage.jsx:17`、`src/pixiv-assistant/capacitor/gallery.js:30` | 存在 |

证据：
- `electron/preload.cjs:11` 全仓库唯一一次 `exposeInMainWorld`，暴露的是 `desktopProxy`，且只有 3 个方法（`getPort` / `saveFile` / `chooseDirectory`）
- `electron/main.cjs` 全文只有 3 个 IPC 处理器：`proxy:get-port`（:173）、`dialog:save-file`（:175）、`dialog:choose-directory`（:196）。**没有 `fs:*` / `download:*` / `http:*`**
- 因此 `window.desktop` 从未被赋值 → `platform.js:14` 的 `isDesktop` 恒为 `false`

连锁不可达（均已追到调用点）：
- `src/pixiv-assistant/capacitor/config.js:51` 的 `if (isDesktop)` 永不成立 → `src/utils/desktopFs.js`（124 行）永远加载不了，桌面端 FileStore 走 web 分支返回 `null`
- `src/pixiv-assistant/capacitor/networkStore.js:36` 的 `isDesktopDownloadAvailable()` 依赖 `desktop?.download` → 恒 false → `src/utils/desktopDownload.js`（36 行）死代码
- `src/utils/platform.js:36` `getGallerySaver()` 的桌面分支不可达

**重要**：这不是"桥名写错"，改名字无法修复——主进程侧对应的 IPC 处理器根本不存在。真正要选的是**补实现 `fs`/`download`/`http`，还是删掉这些代码**。

而 `README.md` 与 `docs/architecture.md` 均声称桌面端已支持"流式下载（真实字节进度）"与"文件系统适配"。

同时，**平台判断散落**（`src/utils/platform.js:9` 明确写着"其余代码一律通过这里判断平台，不要散落 window.Capacitor 判断"，但实际）：
- `window.Capacitor?.isNativePlatform?.()` 重复 5~6 处：`src/main.jsx:10`、`src/hooks/useAndroidBackButton.js:12`、`src/pixiv-assistant/capacitor/config.js:60`、`src/pixiv-assistant/capacitor/metaBackup.js:38`、`src/utils/nativeDownload.js:12`（后者是 `platform.js:24` 的同义复制却未复用）
- `window.desktopProxy` 检测重复 3 处：`src/api/pixiv.js:18`、`src/pages/SettingsPage.jsx:17`、`src/pixiv-assistant/capacitor/gallery.js:30`
- `import.meta.env.DEV` 重复 6 处：`src/api/pixiv.js:11`、`src/api/gif.js:22`、`src/utils/logger.js:10`、`src/utils/proxyCheck.js:18`、`src/pixiv-assistant/capacitor/networkStore.js:18`、`src/pixiv-assistant/core/utils.js:12`
- 讽刺的是 `src/utils/platform.js:24` 导出的 `isNativePlatform` **零消费方**

### S2. 桌面端动图链路选错传输通道（真实功能缺陷）

两份 transport 选择逻辑，判据不一致：

```js
// src/api/pixiv.js:126 — 查 desktopProxy（正确）
fetch: isDesktopShell() ? desktopFetch : (IS_DEV ? devFetch : prodFetch)

// src/api/gif.js:81 — 查 isDesktop（恒为 false，见 S1）
const apiFetch = isDesktop ? desktopFetch : IS_DEV ? browserFetch : prodFetch;
```

后果：桌面端**静图 API 走 `desktopFetch`（正确），动图下载却永远走不到 `desktopFetch`**；生产构建落到 `prodFetch`（CapacitorHttp，Electron 环境不存在），再降级为裸 `fetch`，被 CORS 拦截。桌面端动图下载很可能是坏的。

（严格说：`prodFetch` 在 `src/api/pixiv.js:104-115` 有降级路径，最终失败模式未在真机验证——标注「未验证」；但两处判据不一致本身是确凿的。）

### S3. 存储层：为 2 个状态建了 5 层，门面 7/15 方法零调用

`docs/architecture.md` 声称的链路：Facade（参数校验/错误转换/并发去重）→ Service（业务编排）→ TransitionEngine（Saga 补偿）→ Repository / FileStore → cacheDB / NetworkStore，13 个文件 2,888 行。

**实测门面调用情况**（全仓库 grep `storageFacade.<method>(`）：

| 方法 | UI 调用点 | 方法 | UI 调用点 |
|---|---|---|---|
| `saveFromNetwork` | 1 | `save` | **0** |
| `load` | 1 | `unsave` | **0** |
| `listLiked` | 1 | `delete` | **0** |
| `toggleLike` | 1 | `getState` | **0** |
| `like` | 2 | `getCacheStatus` | **0** |
| `unlike` | 1 | `listByState` | **0** |
| `fillMeta` | 1 | `stats` | **0** |
| `backfillMeta` | 2 | | |
| `getAll` | 1 | | |

`src/pixiv-assistant/capacitor/storageFacade.js:22-190` 的 15 个方法里 8 个是"空值守卫 + 一行转发"。唯一含逻辑的是 `saveFromNetwork`（:32-42）的并发去重（约 12 行 `_saveInFlight` Map）。该门面的真实价值 ≈ 那 12 行 + 一组 `if (!illustId)`。

#### S3.1 Saga 状态机的前提是虚构的

`src/pixiv-assistant/capacitor/fileStore.js:246-248`：

```js
_resolveDir() {                       // 签名无参数；调用方传入的 fromState/toState 被静默丢弃
  return { dir: CACHE_DIR, dirType: 'DATA' };
}
```

7 个调用点均传参（`:66`、`:91`、`:123`、`:124`、`:155`、`:190`、`:211`），全部无效。

因此 `src/pixiv-assistant/capacitor/transitionEngine.js:100-116` 的三步 Saga 实际语义是：
1. 把文件从 `CACHE_DIR/x` 复制到 `CACHE_DIR/x`（同一路径）
2. 更新元数据状态
3. 删除 `CACHE_DIR/x` —— **删除刚复制的文件**

`fileStore.move()`（`fileStore.js:174-179`，零调用）有同样缺陷。

**但这不是正在发生的 bug**（已追完整调用链确认）：`cached` 状态实体只由 `src/pixiv-assistant/capacitor/repository.js:184` / `:241` 的 `toggleLike` / `like` 创建为"轻记录"，而轻记录**没有 `fileName`**；有文件的实体状态一律是 `saved`，走到 `transition()` 会命中 `transitionEngine.js:64-66` 的幂等分支直接返回。所以 `cached→saved` 这条带文件的迁移**当前不可达**。

准确结论：**状态机的文件复制/清理语义从未成立过**，且 `saved→cached`（`unsave`）从 UI 不可达。`docs/architecture.md` 把它列为"⏳ 待办：状态分离失去物理意义"，低估了严重性。

Saga 类（`transitionEngine.js:25-41`）本身也带死机器：`logs` 字段只写不读；`hasCompleted()` 无人调用；`snapshot.oldState` / `snapshot.entityId` 从未被读取。为 2 个状态、1 条不可达迁移保留了一套通用补偿框架。

#### S3.2 同一份 25 字段清单写了 4 遍

`src/pixiv-assistant/capacitor/entity.js` 中逐字段重复：
- JSDoc 声明（:12-39）
- 构造函数赋值（:41-65）
- `fromRecord`（:92-118）
- `toRecord`（:123-149）

`fromRecord` / `toRecord` 实质等价于 `{...record, cacheKey: id}` 的字段改名，无校验、无转换。新增一个字段需改 4 处。`withFlags`（:79-81）、`isCached`（:69）零调用。

#### S3.3 其他重复与封装失效

- `getCacheStatus` 逐字实现两遍：`storageFacade.js:98-105` 与 `storageService.js:141-148`
- "找不到就回退页 0 的动图"查询在 `storageService.js` 复制 **5 次**：`:41-46`、`:65-71`、`:107-113`、`:127-130`、`:259-265`
- `scheduleMetaBackup()` 散落在 10 个方法中（横切关注点未收敛）
- 对外入口 `src/pixiv-assistant/index.js` 导出 23 个符号，其中 **9 个零外部消费者**：`NetworkStore`、`PixivStorageService`、`StorageFacade`、`TransitionEngine`、`FileStore`、`ensureDirectory`、`configurePixiv`、`deleteTabCache`、`loadAllTabCaches` → 封装只是名义上的
- UI 直接穿透门面：`src/context/PixivCacheProvider.jsx:16-17` 直连 `metaBackup.js` + `gallery.js`；`src/utils/hiddenWorks.js:2` 直连 `cacheDB.js`
- `src/api/gif.js:30` 自行 `new PixivRepository()` —— **第二个 repository 实例**，与 `PixivStorageService` 内部那个并存。803 行的 `gif.js` 是一套平行的写入实现（自己构造 entity、自己命名文件、自己导出相册、自己调度 meta 备份、自己写 repository）

### S4. `core/` 的"纯逻辑、无平台依赖"契约不成立

`docs/architecture.md` 与 `src/pixiv-assistant/core/utils.js:4`、`core/constants.js:4` 均声称"无 Node/Browser 依赖，Electron 主进程 + React 前端共用"。实际：

- `src/pixiv-assistant/core/utils.js:12`：`const USE_PROXY = typeof window !== 'undefined' && typeof import.meta !== 'undefined' && import.meta.env?.DEV;`
  - 同时耦合浏览器全局与 Vite 构建期变量
  - 它决定 `pixivReUrl` / `proxyThumb` / `pixivPageUrl` 返回 `/pixiv-img/...`（相对路径）还是 `https://i.pixiv.re/...`（绝对地址）→ **同一个"纯函数"在不同环境返回不同 URL**
  - `src/pixiv-assistant/core/utils.js:95` 硬编码了 Vite 代理路径 `/pixiv-img`（`:28`、`:32`、`:49` 同）
- 依赖方向倒置：`core/utils.js:6` 与 `core/pixivApi.js:23` 都 `import { createLogger } from '../../utils/logger.js'`，而 `src/utils/logger.js:10` 使用 `import.meta.env.DEV` → **core 依赖了外层的 utils 层**，与文档的分层图方向相反
- "Electron 主进程共用"是空话：`electron/main.cjs` 只 import electron/node 与 `scripts/*.mjs`，从不 import core

**实测验证（Node v24 直接 import，非静态分析）**：

| 模块 | 结果 |
|---|---|
| `src/pixiv-assistant/core/constants.js` | OK |
| `src/pixiv-assistant/core/utils.js` | **FAIL** — `Cannot read properties of undefined (reading 'DEV')` |
| `src/pixiv-assistant/core/pixivApi.js` | **FAIL** — 同上 |
| `src/pixiv-assistant/core/pixiv/mappers.js` | **FAIL** — 同上 |

根因链：`core/utils.js:7` 与 `core/pixivApi.js:23` → `src/utils/logger.js:10` 顶层**裸读** `import.meta.env.DEV`（Vite 专有语法，非标准 JS / 非浏览器 API）。

结论修正：**"core 可在任何 JS 环境复用"是可证伪的**，不是风格问题。注意区分两点：
- `core/pixiv/*` 的**代码内容**是平台干净的（`client.js` 只通过注入的 `transport.fetch` 发请求，无 `fetch(` / `localStorage` / `indexedDB` / `Capacitor` 直接调用，已 grep 验证）
- 但 `core/pixiv/*` 的**模块依赖图**不干净（`mappers.js` → `core/utils.js` → `utils/logger.js` → `import.meta.env`），所以连 `mappers.js` 都 import 不了

`core/types.js` 的失效还有一个额外原因：项目没有 `jsconfig.json` / `tsconfig.json`，也没有 `@ts-check` —— 即便有人引用这些 typedef，编辑器也解析不到，**产出的工具收益为零**。

**正面**：`core/utils.js` 的 URL 推导逻辑（`pixivPageUrl` 处理 custom-thumb / ugoira / 2026 内容哈希，`pixivOriginalUrl` 回避不可靠的 `img-original` 路径）注释充分、边界考虑周全，是这套代码里质量最高的部分。问题只在它被放进了错误的依赖位置。

### S5. "作品+页"复合键有 5 套实现、2 种分隔符、散布 10+ 处

同一概念在代码里以三种字符串形态存在，且**不同形态承担不同职责**：

| 格式 | 出现位置 | 承担的职责 |
|---|---|---|
| `illustId_page`（下划线） | `core/utils.js:153-157` `getCompositeKey`；`capacitor/storageFacade.js:35`（内联）；`capacitor/storageService.js:418`、`:320`、`:354`、`:383`（内联） | **IndexedDB 落库主键** |
| `illustId:page`（冒号） | `store/useAppStore.js:11-13` `detailKeyOf`；`components/detail/DetailView.jsx:13` `scrollKeyOf`、`:17` `navKeyOf`、`:334`（JSX key） | 导航栈 / 滚动位置 / React key |
| `pixiv:illustId:page`（前缀+冒号） | `capacitor/entity.js:85` `makeId`（**权威实现**）；`core/utils.js:253` `getCacheKey`（零调用，`_source` 参数完全未使用）；`capacitor/metaBackup.js:149`（内联） | 存储层实体 key |

问题：任一处改分隔符或加字段（如 2026 起 Pixiv URL 的 `-hash` 段）都会**静默错配**，不会有任何报错。

更具体的脆弱点：`src/utils/worksState.js:10` / `:21` 用 `String(key).lastIndexOf('_')` **反解**下划线格式来还原 illustId——传入冒号格式的 key 会静默产出错误 illustId，illustId 含 `_` 时同样出错。这是"格式知识被复制到消费方"的典型脆弱耦合。

`docs/architecture.md:244` 把 `pixiv:{id}:{page}` 定义为"统一 key"，**实际并未统一**。

### S6. core ↔ transport 的错误契约是"用正则解析错误消息字符串"

- transport 侧只抛字符串消息 `HTTP ${status}`：`src/api/pixiv.js:66`、`:85`、`:101`
- core 侧用正则从 message 里抠状态码：
  - `src/pixiv-assistant/core/pixiv/client.js:19` `isCsrfRetryable` 匹配 `HTTP\s+(400|401|403|405|422)`
  - `src/pixiv-assistant/core/pixiv/client.js:89-96` `classifyError` 匹配 `HTTP\s+(\d+)`

后果：换 transport 实现（改成返回 `{status}`、改用 Error 子类、加前缀、走 HTTP/2 库）会**静默破坏 CSRF 重试与中文错误提示**——不报错，只是 CSRF token 过期时不再自动重试、错误提示退化。这是跨层契约用"字符串约定"表达的典型隐患，应显式化（错误对象带 `status` 字段）。

---

## 三、中等问题

### M1. 死代码清单（均已 grep 验证零引用）

| 位置 | 行数 |
|---|---|
| `src/pixiv-assistant/capacitor/transitionEngine.js`（全文，S3.1） | 154 |
| `src/utils/desktopFs.js`（全文，S1） | 124 |
| `src/pixiv-assistant/core/types.js`（全文） | 92 |
| `src/hooks/useImagePreloader.js`（全文） | 45 |
| `src/utils/desktopDownload.js`（全文，S1） | 36 |
| `src/utils/quality.js`（全文） | 34 |
| `fileStore.copy` + `fileStore.move`（:119-179，仅 transitionEngine 使用 / 零调用） | ~70 |
| storageFacade + storageService 的零调用方法（S3） | ~180 |
| `entity.js` 的 `withFlags` / `isCached` | ~10 |
| `src/utils/scroll.js:16` `getScrollTop` / `:20` `setScrollTop` | ~10 |
| `src/pixiv-assistant/core/constants.js:11` `PIXIV_CACHE_TTL` / `:14` `RANKING_MODES` / `:20` `RANKING_MODE_NAMES` | ~15 |
| `src/pixiv-assistant/core/utils.js:253` `getCacheKey` | ~10 |
| `src/utils/logger.js:36` 的 `logger` 具名导出 | 2 |
| `src/utils/platform.js:24` 的 `isNativePlatform`（导出但零 import） | ~6 |
| `src/store/useAppStore.js:64` 的 `tabs` 字段 | 1 |
| **合计** | **≈ 780** |

补充说明：
- `core/types.js` 是纯 JSDoc typedef 文件（`export {}`），**全仓库 0 处引用**（含 `import('./types.js')` 注释形式）。历史评审曾夸它"JSDoc 类型定义完整"，实为孤儿文档。
- `src/utils/quality.js` 是 `gridQuality` 设置（mini/thumb）的**唯一实现**，而 `src/pixiv-assistant/core/utils.js:42-51` 的 `proxyThumb` 完全忽略画质参数 → **设置页的"网格画质"选项改了没有任何效果**（用户可见的失效）。
- `useAppStore.js:64` 的 `tabs` 不仅零消费，其顺序与 `src/App.jsx:28-33` 那份**不一致**（store 是 discover/ranking/search/me，App 是 discover/ranking/me/search），是潜在 bug 源。
- `src/pixiv-assistant/core/constants.js:16` 的 `RANKING_MODES` 含 `monthly_r18`，但 `src/pixiv-assistant/core/pixiv/ranking.js:7-8` 的 `VALID_MODES` 不含 → 传入会被 `ranking.js:16` **静默降级为 `daily`**。已追 UI：`src/pages/RankingPage.jsx:22` 的 `R18_CATEGORIES = ['daily','weekly','male','female']`，**UI 产生不了 `monthly_r18`**，故非活 bug，属过期死副本（地雷）。
- `src/api/gif.js` 帧缓存与播放器层共用（`:24-27` 注释），API 层持有 `blob:` URL 生命周期（`:44-49` `releaseFrames`）→ 传输层混入播放器资源管理。

### M2. 重复函数对照表

| 重复职责 | 位置 A | 位置 B（及 C） |
|---|---|---|
| `i.pximg.net → i.pixiv.re` 改写 | `core/utils.js:48` `proxyThumb` | `api/gif.js:107` `proxyZipUrl`；`capacitor/storageService.js:410` `buildDownloadUrls` |
| 日期路径 + illustId 正则 | `core/utils.js:81` | `capacitor/storageService.js:423`（同一正则复制） |
| cache key 生成 | `core/utils.js:153` | `capacitor/entity.js:85`；`core/utils.js:253`（三种格式，见 S5） |
| 文件名 sanitize | `core/utils.js:164` `safeFileName` | `electron/main.cjs:178`（规则不同：一个删字符、一个换下划线） |
| 文件名生成/解析 | `core/utils.js:164` + `:182` `parseCacheFileName` | `api/gif.js:97` `buildGifFileName`（格式定义与写入方分居两个目录） |
| 缩略图档位 | `utils/quality.js:10` `gridThumbUrl`（`c/48x48`） | `components/ImageGrid.jsx:40` `masonryThumbUrl`（`c/540x540_70`） |
| 平台判断（桌面） | `platform.js:14`（错的） | `api/pixiv.js:18`、`gallery.js:30`、`SettingsPage.jsx:17` |
| 平台判断（原生） | `platform.js:24` | `nativeDownload.js:12` 等 5 处 |
| 下载器（桌面 / 安卓） | `utils/desktopDownload.js:17-37` | `utils/nativeDownload.js:21-42`（结构逐行对应：80ms 节流、`id = url + Date.now()`、referer 固定、`throw new Error('下载无数据')`；差异仅桥对象与事件注册方式） |
| UA / Referer 常量 | `api/pixiv.js:13`（`Chrome/131`） | `core/pixiv/client.js:6`（同款）、`scripts/proxy-utils.mjs:111`（**不带** Chrome 后缀）、`:204`（同前）——4 份 2 种内容 |
| `PIXIV_BASE` | `core/constants.js:7` | `api/pixiv.js:12` 重复定义 |
| 代理路由表 | `electron/main.cjs:75-80` 手写 4 条 `{prefix, fn}` | `scripts/pixiv-proxy.mjs:109-115` 同一份 4 条映射（新增前缀需改两处） |
| base64 转换 | `api/gif.js:125` `base64ToBytes` / `:658` `bytesToBase64` | `utils/desktopFs.js:34` `b64ToBytes` / `:41` `bytesToB64` |
| GIF 判定 | `api/index.js:22`、`saveAllPages.js:25`、`entity.js:68`、`mappers.js:27`、`likeMeta.js:21`、`ImageDetailView.jsx:75`、`GridItem.jsx:50`、`user.js:44` 等 | **共 13 处** |
| 超时包装（AbortController + setTimeout + clearTimeout） | `api/pixiv.js:62-63` / `:79-80` / `:108-109`（三份） | `utils/proxyCheck.js:31-32` |
| 传输模式分支（dev / desktop / prod） | `api/pixiv.js:126`（正确） | `api/gif.js:81`（判据错，见 S2）、`utils/proxyCheck.js:68`、`capacitor/networkStore.js:18` —— **共 4 份** |
| localStorage 迁移 | `utils/appStorage.js:46` `migrateFromLegacyKey` | `utils/hiddenWorks.js:41-53` 自己又实现一遍 |

### M3. React 表现层

- **RankingPage 重复实现 `useTabFeed` 骨架**：`src/pages/RankingPage.jsx` 共 230 行，其中约 110 行（`:47-99` 加载+竞态守卫、`:110-140` 缓存水合、`:143-150` 首拉 gating、`:176-184` 哨兵、`:153-157` refreshToken、`:104-107` registerRefresh）与 `src/hooks/useTabFeed.js:63-104`、`:114-136`、`:138-148`、`:157-168`、`:150-155`、`:109-112` 重复。真实差异只有"多档内存缓存 + 切档秒开"与"档位水合回 useState"。此问题在 2026-08-04 的历史评审（`docs/archive/layering-and-reuse.md:22-38`）中已指出，**至今未修**。
- **页面样板重复**：`error-retry` + "加载中..." + "没有更多了" 在 7 个文件中重复（`DiscoverPage.jsx:88,93,94`、`RankingPage.jsx:204,208,212,213`、`SearchPage.jsx:176`、`BookmarksPanel.jsx:55,60,61`、`FollowingPanel.jsx:51,56,57`、`FollowingAuthorsPanel.jsx:97`、`LikedPanel.jsx:109,113`）。历史评审建议的 `<FeedFooter>` 组件**至今不存在**。
- **cookie 过期判定正则重复 4 处**：`BookmarksPanel.jsx:46`、`FollowingPanel.jsx:42`、`FollowingAuthorsPanel.jsx:75`、`DiscoverPage.jsx:79`，均为 `/(cookie|no_cookie|需要.*Cookie)/i`。`pixivApi` 的 `classifyError` 本可提供 `errorType`。
- **likedSet 存在 3 条同步通道**：`src/context/PixivCacheProvider.jsx:90`（Context 派生） + `pixiv:liked-changed` 自定义事件（派发方 `src/hooks/useGridLikeToggle.js:36`、`src/hooks/useLikeAction.js:30`；唯一监听方 `src/components/panels/LikedPanel.jsx:96`，收到后全量 reload）+ `LikedPanel.jsx:102-105` 自己再从 `feed.items` 构造一份红心集合。详情页点一次❤️会同时触发 Context 更新与全列表重载两份工作。
- **全局状态共 4 类通道**：zustand（`src/store/useAppStore.js`，14 个状态字段 + 13 个 action）、2 个 Context、3 种 window 自定义事件（`pixiv:liked-changed` 4 处、`pixiv:grid-layout-changed` 4 处、`pixiv:toast` 3 处）、localStorage + IndexedDB。其中 `gridLayout`（storage vs 事件）、`likedSet`（Context vs 事件）属同一状态多通道。
- **App.jsx 传 38 个 props**，最大穿透 3 层。纯转发仅 `onOpenSettings` 一条链（`BookmarksPanel` / `FollowingPanel` / `FollowingAuthorsPanel` 自身不用，只转手给 `NeedCookieNotice`）。`registerRefresh` 经 `src/pages/MePage.jsx:36-52` 用 ref 聚合，未穿透到 panel —— 这部分设计是对的。
- **`src/hooks/useTouchGesture.js` 1031 行**：内部构成约为——数学/物理工具（`:94-316`）≈200 行、导航状态机（`:317-394`、`:997-1007`）≈120 行、触摸事件（`:445-746`）≈300 行、**鼠标事件（`:747-933`）≈186 行（几乎逐行镜像触摸逻辑）**、双击缩放/滚轮/关闭（`:395-444`、`:934-996`）≈180 行、状态与 refs（`:27-88`）≈45 行。唯一消费者是 `src/components/MediaLightbox.jsx:95`。最直接的改进不是拆分而是**把鼠标镜像合并为 Pointer Events 单实现（可减约 180 行）**。
- `src/components/detail/DetailView.jsx:264-300`（鼠标）与 `:219-261`（触摸）同样互为镜像副本，判据逐行相同（locked 判定、1.2 轴比例、`velocity > 0.18`）。
- **`useStableCallback`（6 行）唯一消费者是 `useTabFeed`**，本质是在给"调用方把 `fetchPage` 定义成内联对象"打补丁。

### M4. 样式组织

- 7 个 CSS 文件共 3,709 行（`index.css` 1537 + `styles/` 下 detail 886 / lightbox 293 / search 287 / settings 248 / download 232 / me 226）。分工本身合理：`index.css` 负责 reset、design tokens、App 壳、网格；`styles/*.css` 按功能页切分并由组件自行 import。
- **无 CSS Module、无命名前缀**。风险实例：`.tab-pane` 同时用于 App 顶级 Tab（`src/App.jsx:77,89,100,113`）与 MePage 子页签（`src/pages/MePage.jsx:99-101`）；`.hint` / `.chips` / `.error-box` 等泛化类名跨多页共用。目前靠嵌套选择器未撞车，但随体量增长碰撞风险现实存在。
- `!important` 共 **19 处**（index.css 11 / detail.css 3 / lightbox.css 5），**全部是可辩护的 UA 覆盖或 WebView 手势防御**，无滥用。
- `index.css` 有两个 `:root` 块（`:1` 和 `:31`），57 个自定义属性中 `--color-accent`（`:10` 用字面量 `#4f8cff` / `:42` 用 `var(--accent)`）与 `--color-danger`（`:15` / `:43`）**各定义两遍**，风格不一致。
- 变更频率最高文件为 `src/index.css`（63 次提交中改 36 次）、`src/components/detail/ImageDetailView.jsx`（30）、`src/App.jsx`（28）——摩擦集中在样式与详情页，不在架构层。

### M5. 其他

- **`src/api/gif.js`（803 行）不是 API 层**：同一文件内含 HTTP 下载（`:483-516`）、磁盘 ZIP LRU 缓存（`:34-41`、`:241-330`）、fflate 流式解压（`:347`）、Canvas 取像素（`:617-624`）、gifenc 编码（`:658`、`:788`）、相册导出（`:295`、`:783`）、IndexedDB 实体写入（`:30` `new PixivRepository()`、`:756`）、downloadMonitor 埋点（`:676`）、`document`/`canvas` 平台 API。`docs/architecture.md:112` 把它归类为"API 层 / 动图下载链路"与实际职责不符；它是"编解码 + 存储 + 平台"混合体，也是 core/ 之外唯一的 `document` 依赖点。
- **`src/api/saveAllPages.js` 是业务编排而非传输**：`:36` 调 `pixivApi.fetchIllust` 补拉详情、`:44-65` 分页幂等跳过、`:69-85` 批并发（`SAVE_BATCH_SIZE = 3`）、`:74` 直接读写 `pixivCache`。放在 `api/` 目录没有依据，且反向依赖 `api/index.js`（`:2`）。它还在 `:25` 重复了 GIF 判定、`:48` 用 `pixivReUrl` 兜底构造 URL 绕过 core 的 `pixivPageUrl` / `buildDownloadUrls`。
- **`csrfTokenCache` 是模块级可变单例**（`src/pixiv-assistant/core/pixiv/client.js:14`，注释自称"跨 api 实例共享"），与 `createPixivApi` 的工厂语义矛盾，多实例/测试会互相污染。对"纯逻辑层"而言是隐藏全局状态。
- **`utils/` 里混进了两个"状态容器"，与应用已有的 store/context 形成三足鼎立**：
  - `src/utils/hiddenWorks.js:1` import React（`useSyncExternalStore`）、`:2` 直连 `cacheDB.js` 写 IndexedDB（`:28`/`:35`/`:54`）→ 它是 store 不是 util，且绕过 `PixivRepository`/`storageFacade` 直写元数据
  - `src/utils/downloadMonitor.js:17` 依赖 `appStorage`（localStorage）持久化失败任务（`:30`/`:58`）→ 同样是 store
  - 项目同时存在 zustand（`src/store/useAppStore.js`）与 2 个 Context，状态归属出现三种范式
- **依赖方向倒置（除 S4 的 core→utils 外还有一处）**：`src/utils/proxyCheck.js:14` 从 `api/pixiv.js` 反向 import —— utils 层向上依赖 API 层；且该文件把 `CapacitorHttp` 直连写进了"工具"。
- **存储层耦合浏览器全局**：`src/pixiv-assistant/capacitor/networkStore.js:33` 的 `_absUrl` 用 `window.location.origin`。
- **`scripts/` 内部重复**：`proxy-utils.mjs:95-176`（`createApiProxy`）与 `:187-258`（`createImageProxy`）有约 60 行几乎逐行相同的 `send` + 失败重置 agent + 重试一次 + 502/504 收尾逻辑，只差 method/headers；`pixiv-proxy.mjs:31-46` 又自己实现了 `doRequest`/`withRetry`，`:11-23` 的 `proxyError` 与 `proxy-utils.mjs:166-171`、`:251-253` 的错误处理三份重叠。
- **`electron-builder.yml` 的 `files` 含 `scripts/**`**，会把 `scripts/cdp-eval.ps1`（纯调试脚本，`:6` 硬编码某次会话的 CDP page GUID，必然失效；无任何 `package.json` script 或文档引用）打进生产安装包。
- **`ranking.js` 的 Cookie 契约与其它端点不一致**：`core/pixiv/ranking.js:17` 直接 `transport.getCookie()`，其余 6 个端点统一走 `ensureCookie()` → 无 Cookie 时排行榜会**静默发匿名请求**而非报错。
- **同一模块两条入口**：9 个文件直接 import `pixiv-assistant/core/utils.js`（如 `ImageGrid.jsx:3`、`useLikeAction.js:2`、`saveAllPages.js:3`），另 15 个文件走 `pixiv-assistant/index.js` barrel 转出同一批函数。
- **`core/pixivApi.js:47-54` 把 17 个函数平铺进一个命名空间**，无分组；`feed.fetchFollowing` 与 `social.fetchFollowingUsers` 名字近义易混。
- **`docs/architecture.md` 已明显失真**：
  - `:214`/`:276`/`:393` 引用 `utils/storageFeedback.js`，该文件**不存在**
  - `:272-278` 的"工具层"表格只列 5 个文件，实际 15 个
  - `:110-113` 的 api/ 清单漏了 `saveAllPages.js`
  - core 纯度（S4）与目录物理分离（S3.1）的描述与代码不符
- **内联箭头函数破坏 memo**：`src/components/detail/ImageDetailView.jsx:560` 的 `onOpenLightbox={(page) => setLightboxIndex(page)}` 每渲染新建引用；全项目仅 2 处 memo（`src/components/ImageGrid.jsx:144`、`src/components/GridItem.jsx:22`）。
- **可点击 div 不可键盘访问**：`src/components/GridItem.jsx:151-165`、`src/components/detail/DetailPageBlock.jsx:82-92` 是 onClick div，无 `role` / `tabIndex`。其余按钮基本有 `aria-label`，且实现了 `prefers-reduced-motion`（`index.css:1509-1526`）。

---

## 四、明确判定为合理的设计（不建议改动）

为免评审者建议重写，以下经核查确认是好的：

1. **`core/pixiv/*` 的端点分组**：`client`（传输/CSRF/错误分类）/ `mappers`（纯映射）/ `illust`（含 LRU 缓存）/ `search` / `ranking` / `feed` / `user` / `social` 拆分干净、可单测。`illust.js:17-36` 自持 LRU 缓存，TTL/容量均为局部常量。这是全项目质量最高的部分。
2. **transport 依赖倒置方向正确**：`core/pixivApi.js:35-54` 的 `createPixivApi({ fetch, getCookie })` 把平台差异挡在 `api/pixiv.js:60/75/90` 三个函数外，`api/pixiv.js:125-126` 按环境选择实现。设计方向完全正确（问题只在于 `api/gif.js:81` 又写了一份判据不同的，见 S2）。
3. **播放器收敛**：`GifPlayer.jsx`（22 行）/ `UgoiraPlayer.jsx`（22 行）已是薄包装，9 个差异全部参数化进 `FrameAnimPlayer.jsx`（`FrameAnimPlayer.jsx:71-80`）。教科书级收敛。
4. **`useTabFeed` 的收敛**：Discover / Search + 4 个 panel 已共用；`MePage.jsx:36-52` 用 ref 注册聚合刷新，避免 props 穿透与三面板互相覆盖。
5. **App.jsx 已不是上帝组件**：0 个 `useState`、0 个 `useRef`，状态全部迁入 zustand。历史评审（`docs/archive/layering-and-reuse.md:40-54`）的这条批评已解决。
6. **`PixivCacheProvider` 的子集订阅**：`PixivCacheProvider.jsx:31-44` 的 likedSet 结构相等则复用旧 Set 引用，有效避免无关保存动作重渲染网格。这是精细的设计。
7. **`electron/main.cjs:66-80` 复用 `scripts/` 的代理中间件**而非复制实现，没有出现两套代理逻辑（重复的只是路由声明与 CORS 胶水）。
8. **`utils/` 基本无死代码**：15 个文件仅 `scroll.js` 的 2 个导出无人用。`appStorage` / `hiddenWorks` / `likeMeta` / `worksState` 均有活跃消费方（2/4/2/2 处），且与 zustand 无职责重叠（`hiddenWorks` 写 `_meta_hidden_works` 记录，`entity.js:90` 以 `_meta_` 前缀排除出作品记录）。
9. **`desktopFs.js` 的适配器设计**（`desktopFs.js:50-118`，对齐 Capacitor Filesystem 接口）本身是正确的适配器模式——问题只在桥不存在（S1），设计思路没错。
10. **`scripts/proxy-utils.mjs` 的健壮性**：`createAgentHolder`（`:34-50`）支持失效连接重置重试；`createApiProxy`（`:155-174`）只在连接级失败时重试一次、半截流直接掐断——错误处理边界判断准确。
11. **注释质量高于平均水平**：`logger.js:11`、`appStorage.js:1-6`、`downloadMonitor.js:1-16` 都写清了"为什么不这么做"。
12. **`electron/main.cjs:37-50` 的 `withCors`**（劫持 `writeHead` 合并 CORS 头）与 `:96-115` 的端口占用 +1 重试，是针对 Electron `file://` 场景的正确解法；`electron/preload.cjs` 保持极小桥面（3 个方法）符合 `sandbox: true` 的最佳实践。
13. **`api/pixiv.js:39-58` 的 `buildHeaders`** 对 Cookie 头做 dev/desktop/prod 三路分流（`x-pixiv-cookie` vs 直设 Cookie），是对浏览器/壳安全限制的正确处理。
14. **`utils/backHandler.js`、`utils/toast.js`、`utils/logger.js` 是"单一职责、多消费方"的真抽象，不建议合并**；`utils/worksState.js`、`utils/likeMeta.js` 虽小但各有 2 个消费方且语义独立，属可接受的小工具，不是伪抽象。

---

## 五、历史脉络（供判断债务趋势）

- `docs/archive/` 有 **10 份评审、4,659 行**，全部写于 2026-08-03 ~ 08-05（3 天内）。此后至 09-24 无新增评审。
- 部分已修：`usePixivCacheStore.js`（重复的 zustand 缓存 store）已删（提交 `fcd02d8`）；`window.api` 全局对象已收敛；播放器已合并；`storageFeedback.js` 的 Toast 解耦已完成（但文档仍引用该文件）。
- **部分未修**：`RankingPage` 重复 feed 骨架（M3）、`<FeedFooter>` 缺失（M3）、`hiddenWorks` 绕过 Repository（`utils/hiddenWorks.js:2` 直连 `cacheDB`，历史评审 P1 项）、`fillMeta`/`backfillMeta` 合并（仍为两个方法）、`saveItem` 调用链跨层（`api/index.js` 仍依赖 `storageFacade`）。
- 观察：**评审产出速度超过修复速度**，且 `docs/architecture.md` 的"可改进点"表格比代码乐观（把 S3.1 的文件语义缺陷描述为"状态分离失去物理意义"）。

---

## 六、待决策问题（需项目所有者拍板）

1. **桌面端（Electron）是真实目标平台还是当初顺手加的？**
   - 若是真实平台 → 需补实现 `fs` / `download` / `http` 的 IPC 处理器（`electron/main.cjs`）与对应 preload 方法，约 160 行现有代码才能激活
   - 若只是顺手加的 → 删掉 `desktopFs.js` + `desktopDownload.js` + `api/gif.js` 的 desktop 分支 + `platform.js` 的 desktop 分支，比补实现划算
   - **此项决定后续删除范围，建议先定**
2. **`gridQuality` 设置（mini / thumb）**：接回 `proxyThumb`（M1）还是从设置页移除？
3. **`api/gif.js`（803 行平行写入实现 + 第二个 repository 实例）**是否值得并入存储层？这是唯一一处"架构债会导致真实 bug"的地方，但改动面大。

---

## 七、建议的修复顺序（按性价比）

1. 决定桌面端去留（第六节问题 1）
2. 修 `src/api/gif.js:81` 的 transport 判据为 `isDesktopShell()`，与 `api/pixiv.js:126` 统一 —— 一行，可能是桌面端动图的真实修复
3. 删除死代码（M1 清单，约 780 行）—— 风险最低
4. 收敛三套 cache key 为一种；`worksState.js` 改为结构化解构而非 `lastIndexOf('_')`
5. facade + service 合并为一层（保留参数守卫与并发去重，删掉 7 个零调用方法）；`storageService` 里 5 处动图回退查询抽成一个私有方法
6. 抽 `<FeedFooter>` / 共享错误横幅；`RankingPage` 改用 `useTabFeed`
7. `api/gif.js` 并入存储层（需单独一轮）
8. 合并 `useTouchGesture.js` 与 `DetailView.jsx` 的鼠标/触摸镜像副本（可减约 260 行）
9. 修 `docs/architecture.md` 的失真描述，或直接标注为历史文档

---

## 附：核心判断一句话

> 项目的**分层意识**远高于个人项目平均水平，但**抽象密度超过了问题复杂度**：
> 为 2 个状态建了 5 层存储抽象（7/15 门面方法零调用、状态机语义从未成立），
> 同时**平台层的关键抽象从未生效**（`window.desktop` 桥不存在），导致 3 处代码各自绕开它写了正确实现。
> 当前最有价值的动作是**删除约 780 行**并让抽象与现实对齐，而非新增层次。

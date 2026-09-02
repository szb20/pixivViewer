# pixivViewer 项目评估报告

> 评估日期：2026-08-05 | 评估范围：全项目（前端/后端/存储/构建/原生插件）

---

## 一、项目概览

| 维度 | 现状 |
|------|------|
| 前端框架 | React 19 + Vite 8 |
| 状态管理 | zustand 5 + React Context |
| 路由 | react-router-dom 7（自研 Tab 切换） |
| 存储 | IndexedDB + Capacitor Filesystem + Android MediaStore |
| 混合开发 | Capacitor 8（Android） |
| 代码检查 | oxlint + JSDoc 类型标注 |
| 构建产物 | 独立 APK（不依赖 dev server） |
| 源文件数 | ~70 个 JS/JSX 文件 |
| 原生插件 | 1 个 Android Plugin（GallerySaver，509 行） |

---

## 二、文件组织结构 (8/10)

```
pixivViewer/
├── src/
│   ├── api/              # API 适配层（pixiv.js / gif.js / index.js）
│   ├── components/       # UI 组件
│   │   ├── detail/       # 详情页子组件
│   │   ├── icons/        # SVG 图标组件
│   │   └── panels/       # "我"页面子面板
│   ├── context/          # React Context（PixivCacheProvider）
│   ├── hooks/            # 自定义 hooks（useTabFeed / useLikeAction 等）
│   ├── pages/            # 4 个 Tab 页
│   ├── pixiv-assistant/  # 核心业务 + 存储层（独立子模块）
│   │   ├── core/         # 纯逻辑：API 工厂、常量、工具函数、类型定义
│   │   └── capacitor/    # 平台适配：IndexedDB / 文件 / 相册 / 元数据备份
│   ├── store/            # zustand stores
│   ├── styles/           # 按页面/功能拆分的 CSS
│   └── utils/            # 工具函数（logger / toast / 代理检测 / 下载监控等）
├── android/              # Capacitor Android 工程
├── scripts/              # 辅助脚本（代理 / 迁移 / 检查）
├── docs/                 # 10 份设计/回顾文档
├── public/               # 静态资源
└── CLAUDE.md             # AI 辅助开发规范
```

**优点：**
- `src/` 按关注点分层清晰，目录名自解释
- `pixiv-assistant/` 作为独立子模块，`core/`（纯逻辑）↔ `capacitor/`（平台适配）职责边界明确
- `docs/` 积累了 10 份设计和回顾文档，对后续维护价值极大
- CSS 拆分到 `styles/` 目录，按功能模块组织

**不足：**
- `components/` 子目录策略不一致：`detail/`、`icons/`、`panels/` 都开了子目录，但 `panels/` 只有 3 个文件
- 根目录存在 `_remote_metaBackup.js` 以 `_` 开头，暗示是临时/副本文件，但未归类到 `scripts/`

---

## 三、架构分层 (9.5/10)

**这是项目最突出的亮点。** 分层极其清晰：

```
UI 层 (React 组件 / Zustand store)
  └─ API 适配层 (src/api/)
       ├─ devFetch  → Vite 代理 (cookie → x-pixiv-cookie header)
       └─ prodFetch → CapacitorHttp (降级 fetch)
  └─ 核心业务层 (pixiv-assistant/core/)
       ├─ pixivApi.js  → API 工厂 (fetch 可注入)
       ├─ utils.js     → URL 构建 / 缓存 key 生成
       ├─ constants.js → 常量定义
       └─ types.js     → JSDoc 类型定义
  └─ 存储层 (pixiv-assistant/capacitor/)
       ├─ StorageFacade    → 门面：参数校验、并发去重
       ├─ StorageService   → 业务编排：save / unsave / delete / toggleLike
       ├─ TransitionEngine → 状态迁移引擎 (Saga 补偿模式)
       ├─ Repository       → Entity ↔ IndexedDB 映射
       ├─ cacheDB.js       → IndexedDB CRUD（v10 schema，含迁移逻辑）
       ├─ FileStore        → 文件系统操作
       ├─ Entity           → 统一数据模型（不可变风格）
       ├─ NetworkStore     → 网络下载
       ├─ metaBackup.js    → 元数据备份/恢复
       └─ tabCache.js      → Tab 页缓存
```

**关键设计决策：**

1. **Repository 模式**：切换 IndexedDB 到 SQLite 只需改 `repository.js`（注释已写明）
2. **Saga 补偿**：`TransitionEngine` 的 `cached→saved` 迁移采用"复制文件 → 更新元数据 → 删除源文件"三步，失败倒序回滚
3. **Entity 不可变风格**：`withState()` / `withFlags()` 返回新实例，不修改原对象
4. **Factory 注入**：`createPixivApi({ fetch, getCookie })` 让 fetch 实现可替换，测试友好
5. **IndexedDB 版本迁移**：`cacheDB.js` 的 `onupgradeneeded` 覆盖了 v1→v10 的完整迁移路径，含数据迁移（boolean→number、ugoira_→pixiv_、补 authorName 等）

---

## 四、状态管理 (8/10)

**优点：**
- `useAppStore`（zustand）承担全局 UI 状态：Tab 切换、详情页、作者页、搜索种子、设置弹窗——职责集中但不臃肿
- PixivCache 采用 **React Context + useState** 而非 zustand，因为 `PixivCacheProvider` 启动时要串联 4 个异步初始化操作——Context 更适合承载这种复杂度
- `useStableFilteredSet` 实现了"结构相等则复用旧引用"的派生优化，避免无关缓存变更触发全量重渲染
- `useTabFeed` hook 收敛了原先 4 个页面各自实现的缓存水合 + 无限滚动 + 下拉刷新逻辑
- `hiddenWorks` 使用 `useSyncExternalStore` 订阅自定义发布订阅——正确的 React 18+ 外部 store 订阅模式

**不足：**
- `usePixivCacheStore.js`（zustand）和 `PixivCacheProvider.jsx`（Context）**同时存在且逻辑重复**，两者都在启动时调用 `storageFacade.getAll()` 构建 `pixivCache`
- `useAppStore.setActiveTab` 直接操作 DOM（`document.querySelector('.app-content')`），污染了 store 的纯净性

---

## 五、API 层与代理设计 (9/10)

**优点：**
- `devFetch` / `prodFetch` 双通道设计精妙：
  - Dev：cookie 转为 `x-pixiv-cookie` header（绕过浏览器安全限制），经 Vite 代理隧道转发
  - Prod：CapacitorHttp 走系统代理，失败自动降级 `fetch()`
- `proxyCheck.js` 代理连通性检测分 dev/prod 两条路径，能区分「代理未运行（502）」vs「Pixiv 不可达（timeout）」
- Vite 插件在 devServer 启动时注入 pixiv 代理，与前端代码完全解耦
- `buildDownloadUrls()` 优先从 API 返回的 `originalUrl` 推导带日期路径的 URL（命中率高），兜底短链推导

**不足：**
- `saveItem` 作为统一保存入口，逻辑只有 5 行但调用链跨了 `api/` → `pixiv-assistant/` 两层

---

## 六、组件设计 (7.5/10)

**优点：**
- `ImageGrid` 用 `React.memo` + `useMemo` 过滤隐藏作品，避免无关变更触发全量重渲染
- `ErrorBoundary` 支持 `fallback` / `FallbackComponent` / `onReset` 多种降级策略，每个 Tab 页和详情页都独立包裹
- `PullToRefresh` 纯手写动画（`requestAnimationFrame` easing），不依赖第三方库
- `DetailView` 内置浏览历史栈（stackRef），支持"推荐→点图→返回"的原地导航，正确保存/恢复滚动位置
- `ToastHost` 通过 `CustomEvent` 解耦——任何模块都能发 toast 而无需知道宿主位置
- `MediaLightbox` 支持图片缩放 + 滑动翻页 + 视频/iframe 嵌入，图片预加载相邻 2 张，网络图片加载失败最多重试 3 次
- `DownloadMonitor` 使用 `useSyncExternalStore` 订阅下载状态，圆环 SVG 进度条

**不足：**
- `ImageGrid.toggleLike` 回调逻辑过长（~18 行），包含乐观更新 + API + toast + 回滚 + 事件广播
- `MediaLightbox.renderVideoContent` 函数过长（~100 行），抖音/iwara/B站/通用四种视频类型耦合在一个 switch 里
- 4 个播放器组件（`GifPlayer` / `UgoiraPlayer` / `FrameAnimPlayer` / `VideoPlayer`）是否存在共享逻辑可提取

---

## 七、存储层 (8/10)

**优点：**
- 三层存储架构合理：IndexedDB（元数据）→ Capacitor Filesystem（缓存文件）→ MediaStore（相册持久化）
- `Repository` 的旧格式 key 兼容逻辑（`pixiv_{id}_{page}` → `pixiv:{id}:{page}`），自动迁移 + 保留旧记录
- `TransitionEngine` Saga 补偿模式：复制→更新→清理，失败倒序回滚
- `metaBackup.js` 实现了 IndexedDB ↔ 系统相册备份的双向同步，覆盖「卸载重装后数据恢复」
- `GallerySaverPlugin.java` 处理了 Android Q+/Tiramisu+ 的权限变化、IS_PENDING 两阶段提交、旧备份清理——实现稳健
- `cacheDB.js` 的 `getByStatePaginated` 优先使用复合索引 `[state, cachedAt]`，fallback 到全表扫描——有性能降级策略
- `appStorage` 将多个 localStorage key 收敛为一个 `pixiv_viewer_app` key，避免命名空间污染

**不足：**
- `Repository.fillMeta` 和 `Repository.backfillMeta` 功能高度重叠
- `hiddenWorks` 直接依赖 `cacheDB` 层的 `putMeta`，绕过了 Repository 抽象

---

## 八、代码质量与工程化 (8/10)

**优点：**
- JSDoc 类型定义完整（`types.js` 覆盖所有 Pixiv 数据模型），IDE 智能提示友好
- 每个文件顶部都有职责描述注释
- `logger.js` 的生产/开发日志级别自动切换（dev=debug, prod=warn）
- `.oxlintrc.json` 配置了 React hooks 规则和 `jsx-no-target-blank`
- `CLAUDE.md` 编写质量高——涵盖 CSS 规范、构建流程、变量约定
- `vite.config.js` 的 `cssTarget: 'chrome110'` + 注释解释了为什么不用 `-webkit-backdrop-filter`
- `capacitor.config.ts` 的 `CAP_DEV=1` 条件编译，默认加载本地资源，不会被误打包 dev server 地址

**不足：**
- 项目使用 `.jsx` + JSDoc 而非 TypeScript（个人项目合理取舍，但协作时建议考虑）
- `.env` 文件被 git tracked（含 cookie/代理密码等敏感信息）
- `_remote_metaBackup.js`（根目录）与 `metaBackup.js` 的关系不明
- 部分 inline style（`ErrorBoundary`、`App.jsx` 的 `display:none` div）可提取到 CSS

---

## 九、Android 原生插件 (9/10)

`GallerySaverPlugin.java`（509 行）实现了：
- 图片保存/读取/存在性检查/删除（`MediaStore.Images`）
- 元数据备份写入/读取/列出/删除（`MediaStore.Downloads`，卸载后保留）
- 通用文件保存（`MediaStore.Files`，用于 ZIP 无损副本）
- 权限适配：Android Q+ 免权限，Q 以下申请 `WRITE_EXTERNAL_STORAGE`，Tiramisu+ 用 `READ_MEDIA_IMAGES`
- 写入前先删旧文件（避免 MediaStore 自动加 `(N)` 后缀）
- `IS_PENDING` 两阶段提交（防止相册扫描到不完整的文件）

---

## 综合评分

| 维度 | 评分 | 权重 | 加权 |
|------|------|------|------|
| 文件组织 | 8 / 10 | 10% | 0.80 |
| 架构分层 | 9.5 / 10 | 25% | 2.38 |
| 状态管理 | 8 / 10 | 15% | 1.20 |
| API 层与代理 | 9 / 10 | 15% | 1.35 |
| 组件设计 | 7.5 / 10 | 15% | 1.13 |
| 存储层 | 8 / 10 | 10% | 0.80 |
| 代码质量与工程化 | 8 / 10 | 10% | 0.80 |
| **总分** | | | **8.46 / 10** |

---

## 20 个优化点

### P0 - 必须修复

**1. 去重：删除冗余的缓存状态管理层**

`usePixivCacheStore.js`（zustand store）和 `PixivCacheProvider.jsx`（React Context）同时存在且逻辑重复，都在启动时调用 `storageFacade.getAll()` 构建 `pixivCache`。大多数组件实际使用 Context 版本，zustand store 是遗留代码。建议删除 `usePixivCacheStore.js`，统一走 Context。

**2. 安全：`.env` 加入 `.gitignore`**

`.env` 文件含 PHPSESSID cookie 和代理地址，已被 git tracked。应立即从 git 历史中移除，加入 `.gitignore`，只保留 `.env.example` 作为模板。

**3. 修复 `GallerySaverPlugin.java` 注释与代码不一致**

`readMeta` 方法的注释写着"用 LIKE 匹配"但实际代码用的是精确匹配 `=`——注释与实现不一致，需统一。

---

### P1 - 建议尽快处理

**4. 解耦：`useAppStore.setActiveTab` 移除 DOM 操作**

Zustand store 不应直接操作 DOM。`setActiveTab` 中的 `document.querySelector('.app-content')` 和滚动位置读写应移到组件层或自定义 hook 中。Store 只负责数据状态，DOM 操作由订阅方执行。

**5. 提取 `ImageGrid.toggleLike` 为自定义 hook**

`ImageGrid.jsx` 中的 `toggleLike` 回调（18 行）包含乐观更新、API 调用、toast、失败回滚、事件广播。应封装为 `useGridLikeAction` hook（可复用 `useLikeAction` 的部分逻辑），让组件回归展示。

**6. 简化：`Repository.fillMeta` 与 `backfillMeta` 合并**

两个方法功能高度重叠（都是回填缺失的展示元数据），区别仅在于填充的字段列表略有不同。建议提取公共的 `_fillMissingFields(record, meta, fields)` 私有方法，两个公开方法做薄封装。

**7. 解耦：`hiddenWorks` 不直接调 `cacheDB`**

`hiddenWorks.add()` 和 `init()` 直接调用 `cacheDB` 层的 `putMeta` / `getMeta`，绕过了 Repository 抽象。应通过 `storageFacade` 或 Repository 统一入口，保持分层纯净。

**8. 拆分 `MediaLightbox.renderVideoContent`**

`renderVideoContent` 函数约 100 行，抖音/iwara/B站/通用四种视频类型耦合在一个 switch 里。建议每种视频类型拆分为独立组件（`DouyinPlayer` / `IwaraPlayer` / `BilibiliPlayer` / `GenericVideoPlayer`），`MediaLightbox` 只做路由分发。

---

### P2 - 优化改进

**9. 统一组件子目录策略**

`components/` 下 `detail/`、`icons/`、`panels/` 都开了子目录，但策略不一致。建议统一规则：>=3 个关联文件的组件建子目录，否则平铺。

**10. 澄清 `_remote_metaBackup.js` 与 `metaBackup.js` 的关系**

根目录的 `_remote_metaBackup.js` 以 `_` 开头（否定式命名），暗示是临时/副本文件。应加注释说明用途，或归类到 `scripts/`，或删除。

**11. 提取 inline style 到 CSS**

`ErrorBoundary.jsx` 的内联样式（padding、textAlign、color 等）和 `App.jsx` 的 `display:none` div 应提取到 CSS 类中，利用已定义的 CSS 变量（`--text-secondary`、`--accent` 等）。

**12. 统一 `saveItem` 的调用链**

`saveItem`（`api/index.js`）只有 5 行但跨了 `api/gif.js` → `storageFacade` 两层。考虑把 GIF 保存逻辑也收进 `StorageFacade`，由 facade 内部判断类型分发。

**13. 4 个播放器组件提取共享逻辑**

`GifPlayer`、`UgoiraPlayer`、`FrameAnimPlayer`、`VideoPlayer`（内嵌于 `MediaLightbox`）都是媒体播放器。审视是否有共同的播放控制逻辑（播放/暂停/进度/自动播放策略）可提取为 `useMediaPlayer` hook。

**14. 给 `PixivCacheProvider` 启动初始化添加进度指示**

`PixivCacheProvider` 启动时串联 4 个异步操作（隐藏列表→权限→备份恢复→相册对账），如果数据量大可能要数秒。建议添加 `initializing` 状态标记，让 UI 显示加载指示器而非空白。

**15. `cacheDB.js` 的 `getByStatePaginated` 诊断信息生产环境关闭**

`getByStatePaginated` 返回的 `_diag` 字段包含内部诊断信息（dbVersion、indexNames、fallback 等），生产环境不需要暴露。建议仅在 `import.meta.env.DEV` 时附加。

---

### P3 - 锦上添花

**16. 考虑渐进式迁移到 TypeScript**

项目使用 JSDoc 做类型标注，在个人项目中合理。如果未来考虑协作或代码量继续增长，建议渐进迁移：先用 `tsconfig.json` 的 `checkJs` + `allowJs` 模式，逐步将核心模块（`pixiv-assistant/core/`）改为 `.ts`。

**17. 添加单元测试**

当前无测试文件。建议至少为核心模块添加测试：
- `PixivEntity.makeId` / `fromRecord` / `toRecord` — 数据转换正确性
- `TransitionEngine.transition` — Saga 补偿逻辑
- `buildDownloadUrls` — URL 推导优先级（已导出且注释写了"便于单元测试"但还没写）

**18. 添加 CI 配置**

添加 GitHub Actions 或其他 CI，至少包含：`oxlint` 代码检查 + `vite build` 构建验证 + 未来可能的单元测试。

**19. `useTabFeed` 支持错误重试**

`useTabFeed` hook 的 `load` 函数在失败时只设置 `error` 状态，没有暴露重试方法。建议在返回值中增加 `retry` 函数，让 UI 层可以绑定重试按钮。

**20. 添加手动测试清单**

`docs/` 已有 10 份设计文档但缺少测试清单。建议添加 `testing-checklist.md`，列出关键用户路径（启动→浏览→详情→保存→喜欢→设置→搜索→排行），方便每次发版前回归。

---

## 总结

**这是一个架构设计非常出色的个人项目。** 分层清晰（5 层严格分离）、存储层设计周全（Saga 补偿 + 版本迁移 + 备份恢复）、状态管理有目的地混用 Context 和 zustand、代理适配覆盖 dev/prod 双环境、Android 原生插件处理了 3 个 Android 版本的权限兼容细节。

**核心亮点：**
- Saga 补偿模式的 `TransitionEngine`（企业级设计模式）
- IndexedDB v1→v10 的完整迁移路径（向后兼容做到极致）
- `useStableFilteredSet` 的结构相等优化（React 性能优化细节到位）
- API 工厂 + 双通道 fetch（dev/prod 适配精准）

**主要扣分项：**
- 一处明显的逻辑冗余（两个 pixivCache 实现并存）
- 少量关注点混入（store 直接操作 DOM）
- `.env` 敏感信息泄露

整体水平远超一般的个人 side project，接近专业生产级代码。

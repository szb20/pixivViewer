# pixivViewer

## CSS 规范

- **覆盖规则必须写在「被覆盖规则所在的文件」里。**
  Vite 按 import 顺序拼 CSS，`src/index.css` 永远排在 `src/styles/*.css` 之前（后者由组件 import）。
  所以写在 `index.css` 的跨文件覆盖会被静默盖掉——改完看着生效了，其实没有。
  典型翻车现场：`.dialog-overlay[data-variant="download"]`、`.settings-overlay`、
  `.side-nav--drawer`（写在 `navDrawer.css`，靠「组件 CSS 晚于 index.css」才盖得住 `shell.css` 的 `.side-nav`）。
  同一文件内还有第二条：**`@media` 不加特异性，媒体块若写在它所覆盖的基础规则之前，整块会被静默盖掉。**
  桌面块一律放文件末尾。（`settings.css` 踩过：桌面块原本在开头，于是桌面设置页一直在用手机端的
  毛玻璃版，和文件里的注释、和本文档都相反，却没有任何报错。）
  判定方法：**在目标元素上限一下 computed style，别靠肉眼**。

- **几何量走变量，不要新增魔法数字。**
  桌面侧边栏宽度用 `--sidebar-w`；手机端导航在抽屉里，宽度由 `navDrawer.css` 的 `.drawer-panel` 给。
  底部**没有**悬浮栏了：页面收尾留白只有 `.page` 的 `--sp-4` 加 `.app-content` 的
  `env(safe-area-inset-bottom)`。（2026-10 手机端导航全部移入抽屉之前，这里有一整套由
  `--bottom-chrome-h` 推导的偏移 —— `.chips-bottom` / `.download-fab` / `.sub-tab-bar` / `.me-page`，
  连同变量本身已经一起删掉，别再照旧文档去找它。）

- **断点 `900px`（桌面）是硬编码的，改它要全库搜。**
  它同时出现在 CSS 与 JS（`ImageDetailView` 的 `useLargePreview` 等）。目前没有统一常量，改前先
  `grep -rn "900px" src/`。

- **不要使用 `-webkit-backdrop-filter`**：在某些安卓 WebView 上会导致 `backdrop-filter` 失效，只写标准属性 `backdrop-filter` 即可。

- **动态变化的 `aria-*` 属性不要当样式钩子，开/关态走 class。**
  本机 Electron（Blink，与安卓 WebView 同源）实测：改 `aria-checked` / `aria-pressed` **不会让元素样式失效**，
  `[aria-checked="true"] { ... }` 里的颜色/位移会停在旧值上，直到别处的改动顺手触发一次重算才跟上
  —— 表现为「开关拨了没反应」，而 `matches()`、`getAttribute()`、DOM 检查全都正常，极难查。
  样式钩子一律用 class（`.active` / `.open` / `.on` / `.side-nav-r18--on`），`aria-*` 照旧输出给读屏器。
  挂载时就定死的静态属性（`[data-variant]` / `[data-type]`）不受影响，可以继续用。

- **毛玻璃通用样式**（定义在 `src/styles/base/shell.css`）：
  - `.frosted` — 深色玻璃底 `rgba(15,17,21,0.55)` + `blur(12px)`
  - `.frosted-light` — 浅色玻璃底 `rgba(255,255,255,0.12)` + `blur(8px)`
  - `.glass-icon-btn` — 圆形玻璃图标按钮
  - **桌面端（≥900px）只有「压在图片上的控件」才用毛玻璃**：灯箱、图片角标（`.detail-hero-pages`、
    `.grid-pages`）、`.glass-icon-btn`。结构性表面一律实底 —— 侧边栏、详情页右栏、搜索胶囊走
    `--bg-panel` / `--bg-secondary` 色阶，设置页与对话框同理，见各文件里的桌面块。
    理由：桌面端这些面板底下是纯色，blur 只会把同一块灰糊成「说不清为什么差一点」的另一块灰，
    相邻面板还会各自调出一档 α 变成接缝。层级靠色阶，不靠叠玻璃。
  - **搜索胶囊压在缩略图上却仍走实底，是上面那条的刻意例外。**
    它底下穿过的就是作品图，blur 只会把图糊成灰浆；但实底又会在内容滚到视口顶时
    切出一条硬边，所以硬切交给遮罩而不是模糊：`.search-fade`（`search.css` 桌面块）
    从 `--bg` 渐隐到透明，由 `SearchPage` portal 到 `.app`，压在内容之上、胶囊之下。
    改胶囊高度要同步改它的实底段（两边注释都写了算式）。

- **CSS 变量**（定义在 `src/styles/base/tokens.css`）：
  - `--bg`, `--bg-panel`, `--bg-secondary` — 背景色
  - `--border` — 边框色 `rgba(255,255,255,0.08)`
  - `--text-primary`, `--text-secondary`, `--text-tertiary` — 文字色
  - `--accent`, `--danger`, `--ok` — 强调色
  - `--sidebar-w` — 布局几何（桌面侧边栏宽度）
  - `--r-xs/sm/md/lg/xl`（4/8/12/16/24）+ `--r-pill` / `--r-circle` — 圆角刻度
  - `--sp-1..6`（4/8/12/16/24/32）— 间距刻度，只管 padding / margin / gap
  - `--t-fast/base/slow`（0.16/0.2/0.25s）— **transition** 时长；`animation` 的时长是个体动效设计，不在刻度里
  - 别名变量（`--color-*`）映射到上述变量，供搬运组件使用
  - 三套刻度是**闭集**：新 CSS 只从刻度取值，别再写字面值。例外（保留字面值）：1~3px 的
    光学微调、宽高/缩进/限宽这类几何量。网格的 `--grid-gap` / `--grid-pad-x` 是独立旋钮
    （手机 4px / 桌面 12px），不跟 `--sp-*` 联动。
  - `--scrollbar-w` 定义在 `responsive.css` 的桌面块（和滚动条规则放一起），不在 tokens.css。

## 状态放哪

有一条判据，别每次靠感觉：

- **跨 tab 存活，或有两个以上渲染树要读** → 放 `src/store/useAppStore.js`。
  例：`meSubTab`（手机是抽屉里的二级项、桌面是侧边栏）、`rankingCategory`、`downloadOpen`。
- **只需在单个组件子树内共享** → 组件局部 `useState`。
- **是非 React 的单例，且要被 hook 订阅** → 模块单例 + `useSyncExternalStore`。
  例：`hooks/useImageSource.js`（全局来源）、`hooks/useSourcesExpanded.js` 与
  `hooks/useSectionExpanded.js`（侧边栏折叠偏好，桌面与抽屉共用一份）、`utils/downloadMonitor.js`。

放错的代价是具体的：状态一开始放在组件里，等侧边栏也要读时就必须上提，
而每上提一次都要重接动画、保活、缓存恢复这几处——所以**能预先判断就预先判断**。

## 错误处理

仓库里有不少 `catch { }`，其中绝大多数是**正当的尽力而为**：`URL.revokeObjectURL` 的清理、
Capacitor 插件在 Web/桌面端的必然失败、localStorage 写满——这些吞掉是对的，别去"修"它们。

要区分的是另一类：**失败会静默改变用户可见行为**的。比如
`saveTabCache(...).catch(() => {})`——缓存没写进去，下次冷启动就是白等一次网络，
而日志里什么都没有。这类走 `createLogger(tag).debug(...)`：
生产构建下 `debug` 会被 `utils/logger.js` 自动丢弃，开发/排查时能看见，零成本。

判断标准一句话：**「如果它一直失败，我会不会以为是别的原因？」** 会 → 加 debug 日志。

## 校验

```bash
npm run lint                 # oxlint；CI 也跑这个
node .claude/skills/run-desktop/driver.mjs smoke   # 启动桌面端跑一遍，有 error/4xx 退出码非 0
```

改布局（尤其是响应式断点、手机端导航）后跑：

```bash
node .claude/skills/run-desktop/driver.mjs responsive
```

它逐档宽度（420/899/900/1100/1600，含 1100×500 的宽而矮）**断言**：手机档没有常驻 `.side-nav`
（导航只在抽屉里）、有汉堡入口、底部 chrome 无残留、`.app-content` 底部内边距为 0；桌面档
`.side-nav` 为 `flex`、`.app` 转行布局；最后在 420 宽度下开抽屉，验证四个主项、点主项自动关、
二级项跟着展开。断言失败会 `FATAL` + 退出码 1，是手机端回归的主要防线。

## Build APK

Building a standalone APK (runs independently on phone, no dev server needed). Production build is the default — no env var required:

```bash
npx cap sync android && cd android && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The Capacitor config (`capacitor.config.ts`) loads bundled local assets (`webDir/dist`) by default. Dev-server mode is opt-in: set `CAP_DEV=1` so `server.url` points at `http://192.168.1.2:5182` (hot-reload only; never ship this, or the APK will try to reach the dev server and show a blank page).

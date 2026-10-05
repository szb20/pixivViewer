# pixivViewer

## CSS 规范

- **覆盖规则必须写在「被覆盖规则所在的文件」里。**
  Vite 按 import 顺序拼 CSS，`src/index.css` 永远排在 `src/styles/*.css` 之前（后者由组件 import）。
  所以写在 `index.css` 的跨文件覆盖会被静默盖掉——改完看着生效了，其实没有。
  典型翻车现场：`.dialog-overlay[data-variant="download"]`、`.settings-overlay`、`.chips-bottom`。
  判定方法：**在目标元素上限一下 computed style，别靠肉眼**。

- **几何量走变量，不要新增魔法数字。**
  底部悬浮栏相关的一切偏移都由 `--bottom-chrome-h` 推导（`.app-content` 的 padding-bottom、
  `.chips-bottom` / `.download-fab` / `.sub-tab-bar` / `.me-page` 的偏移）。桌面侧边栏宽度用 `--sidebar-w`。
  手机端要调底栏几何只改变量；桌面端把 `--bottom-chrome-h` 置 0 即可整体失效。

- **断点 `900px`（桌面）是硬编码的，改它要全库搜。**
  它同时出现在 CSS 与 JS（`ImageDetailView` 的 `useLargePreview` 等）。目前没有统一常量，改前先
  `grep -rn "900px" src/`。

- **不要使用 `-webkit-backdrop-filter`**：在某些安卓 WebView 上会导致 `backdrop-filter` 失效，只写标准属性 `backdrop-filter` 即可。

- **毛玻璃通用样式**（定义在 `src/index.css`）：
  - `.frosted` — 深色玻璃底 `rgba(15,17,21,0.55)` + `blur(12px)`
  - `.frosted-light` — 浅色玻璃底 `rgba(255,255,255,0.12)` + `blur(8px)`
  - `.glass-icon-btn` — 圆形玻璃图标按钮
  - 桌面端（≥900px）刻意**不用**毛玻璃：设置页、对话框一律实底，见各文件里的桌面块。

- **CSS 变量**（定义在 `src/index.css`）：
  - `--bg`, `--bg-panel`, `--bg-secondary` — 背景色
  - `--border` — 边框色 `rgba(255,255,255,0.08)`
  - `--text-primary`, `--text-secondary`, `--text-tertiary` — 文字色
  - `--accent`, `--danger`, `--ok` — 强调色
  - `--bottom-chrome-h`, `--sidebar-w` — 布局几何
  - 别名变量（`--color-*`）映射到上述变量，供搬运组件使用

## 状态放哪

有一条判据，别每次靠感觉：

- **跨 tab 存活，或有两个以上渲染树要读** → 放 `src/store/useAppStore.js`。
  例：`meSubTab`（手机是底部子页签、桌面是侧边栏）、`rankingCategory`、`downloadOpen`。
- **只需在单个组件子树内共享** → 组件局部 `useState`。
- **是非 React 的单例，且要被 hook 订阅** → 模块单例 + `useSyncExternalStore`。
  例：`hooks/useImageSource.js`（全局来源）、`utils/downloadMonitor.js`。

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

改布局（尤其是底部栏几何、响应式断点）后跑：

```bash
node .claude/skills/run-desktop/driver.mjs responsive
```

它会逐档宽度（420/899/900/1100/1600）检查手机端与桌面端的导航形态和关键几何，
是手机端回归的主要防线。

## Build APK

Building a standalone APK (runs independently on phone, no dev server needed). Production build is the default — no env var required:

```bash
npx cap sync android && cd android && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The Capacitor config (`capacitor.config.ts`) loads bundled local assets (`webDir/dist`) by default. Dev-server mode is opt-in: set `CAP_DEV=1` so `server.url` points at `http://192.168.1.2:5182` (hot-reload only; never ship this, or the APK will try to reach the dev server and show a blank page).

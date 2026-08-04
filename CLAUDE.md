# pixivViewer

## CSS 规范

- **不要使用 `-webkit-backdrop-filter`**：在某些安卓 WebView 上会导致 `backdrop-filter` 失效，只写标准属性 `backdrop-filter` 即可。

- **毛玻璃通用样式**（定义在 `src/index.css`）：
  - `.frosted` — 深色玻璃底 `rgba(15,17,21,0.55)` + `blur(12px)`
  - `.frosted-light` — 浅色玻璃底 `rgba(255,255,255,0.12)` + `blur(8px)`
  - `.glass-icon-btn` — 圆形玻璃图标按钮

- **CSS 变量**（定义在 `src/index.css`）：
  - `--bg`, `--bg-panel`, `--bg-secondary` — 背景色
  - `--border` — 边框色 `rgba(255,255,255,0.08)`
  - `--text-primary`, `--text-secondary`, `--text-tertiary` — 文字色
  - `--accent`, `--danger`, `--ok` — 强调色
  - 别名变量（`--color-*`）映射到上述变量，供搬运组件使用

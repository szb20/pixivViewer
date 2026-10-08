---
name: run-desktop
description: 构建、启动并驱动 PixivViewer 的 Electron 桌面端，抓取渲染进程日志、HTTP 失败与截图。当被要求「启动桌面端 / 跑一下 Electron / 截图桌面应用 / 检查桌面端有没有异常日志」时使用。
---

# 运行桌面端（Electron）

桌面壳是 [electron/main.cjs](../../../electron/main.cjs)：内嵌一份 Pixiv/Booru 代理服务
（默认 `127.0.0.1:51380`，被占用则 +1），然后加载 `dist/index.html`（生产构建）或 dev server。

驱动脚本 [driver.mjs](driver.mjs) 用 **CDP + Node 内置 WebSocket** 驱动它 —— 本仓库没有
playwright/puppeteer，也不需要为此装依赖。

## 前置

```bash
npm run build          # 桌面壳默认加载 dist/，改完 src/ 必须重新构建
```

（或 `npm run dev` 另开一个终端，然后给驱动加 `--dev`。）

## 用法

```bash
node .claude/skills/run-desktop/driver.mjs smoke
node .claude/skills/run-desktop/driver.mjs report
node .claude/skills/run-desktop/driver.mjs eval "document.title"
node .claude/skills/run-desktop/driver.mjs shot 我的截图
```

| 选项 | 说明 |
|---|---|
| `--dev` | 加载 vite dev server（需先 `npm run dev`），默认加载 `dist/` |
| `--port <n>` | CDP 调试端口，默认 9222 |
| `--out <dir>` | 截图目录，默认 `log/desktop-shots` |
| `--timeout <ms>` | 等待渲染进程超时，默认 30000 |
| `--size <WxH>` | 用 CDP 把渲染视口固定成指定尺寸（Electron 窗口本身不变），配合任何场景用，例如 `eval "..." --size 1700x950` |

| 场景 | 做什么 |
|---|---|
| `smoke` | 启动 → 依次点「推荐/排行/我」→ 点「搜索」唤起悬浮搜索框、框内输入并回车进结果页 → 滚动 → 抓日志与截图 |
| `sidebar` | 桌面侧边栏专项：二级页签切换、覆盖层（详情/设置）是否让出侧边栏、点导航是否关掉覆盖层 |
| `wideDetail` | 详情页宽图专项：宽图（宽高比 > 1）走「图在上、信息在下」的上下布局、竖图保持左右分栏；各截一张图 |
| `responsive` | 逐档宽度（420/899/900/1100/1600，含 1100×500 的宽而矮）**断言**导航形态与关键几何，失败即 FATAL + 退出码 1；开头会先做一次搜索让搜索页成为当前 tab，探针才在手机档位也拿得到 `.search-bar--top`；末尾在 420 宽度开抽屉验「四个主项 + 点选自动关 + 二级项展开」。**手机端回归靠它** |
| `report` | 冒烟之外，额外诊断 Cookie 是否生效、破图、收藏页 |
| `a11y` | 键盘可达性断言：侧边栏方向键导航、覆盖层焦点移入/归还、Esc 关闭（这些看截图看不出来） |
| `downloads` | 下载管理专项：注入进行中/失败/已完成三类假任务，验证分组与「已下载/总大小 · 速度」显示。**需配 `--dev`**（用 `window.__pixivViewer` 调试口）；不真下载是因为桌面点下载会弹原生保存框，自动化关不掉 |
| `eval <js>` | 在渲染进程求值（`awaitPromise`，async IIFE 可直接写），打印结果 |
| `shot [name]` | 只截一张图 |

**退出码**：有 console error 或 HTTP 4xx/5xx 时为 `1`，可直接当断言用。
完整日志另存到 `log/desktop-driver.log`，截图在 `--out` 目录。

## 坑（都是踩过的）

- **`ELECTRON_RUN_AS_NODE=1`** —— 本机 shell 预设了这个变量，会让 `electron.exe` 退化成普通
  node，直接报 `electron.exe: bad option: --remote-debugging-port=9222`。
  驱动里已在 spawn 前 `delete`，**但你自己手敲 `electron .` 时同样会中招**。
- **必须先 `npm run build`** —— 桌面壳加载 `dist/`，不跑构建就是在测上一版产物。驱动会检查并提前报错。
- **主进程 stdout 就是日志出口** —— [main.cjs](../../../electron/main.cjs) 把渲染进程的
  `console-message` 转发成 `[renderer:<level>] <msg> (源码位置)`，代理启动信息是 `[desktop] 代理服务已启动`。
  用 `--dev` 时还会自动开 DevTools。
- **`grid-hide` 的 ✕ 不是坏图** —— 网格里每个作品右上角的 ✕ 是「不再推荐」按钮，
  `innerText` 会把它抓出来，别误判成加载失败。判破图要看 `img.complete && naturalWidth === 0`。
- **启动时那条 400 已修** —— 探针原先打 `/ajax/discovery/artworks`，该端点无 Cookie 恒回 400；
  现改为打首页 `/pixiv-api/`（见 [proxyCheck.js](../../../src/utils/proxyCheck.js)）。
  若又看到 400，说明探针端点被改回去了。

## 注意

`.claude/` 在 [.gitignore](../../../.gitignore) 里，所以这个 skill 只存在于本机，不会提交。
要分享/备份需先放开忽略规则。

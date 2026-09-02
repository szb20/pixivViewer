# PixivViewer

从 llm-chat 中独立出来的 Pixiv 图片浏览 / 下载应用（个人自用）。支持网页开发预览与 Android（Capacitor）打包。

## 功能

- **四个浏览入口**：推荐 / 排行 / 我 / 搜索（双列瀑布流 + 无限滚动 + 下拉刷新）
- **排行**：日榜 / 周榜 / 月榜 / 男性向 / 女性向 / 新人 / 原创 / R18G，支持 R18 开关
- **「我」聚合页**：关注 / 订阅 / 喜欢 / 收藏 四个子面板
- **搜索**：按标签 / 作品 ID 搜索，保留最近搜索历史
- **多图详情页**：全部页面上下堆叠、进入视口懒加载原图、本地相册优先
- **全屏灯箱**：滑动翻页 / 双击与双指缩放
- **相关推荐**：详情页可跳转相关作品与作者作品页（带历史栈返回）
- **Ugoira 动图**：浏览器端 ZIP 解帧播放，支持保存到相册（gifenc 编码 GIF）
- **下载到相册**：IndexedDB 元数据 + Capacitor Filesystem 文件，带下载监控
- **设置**：主题色、Pixiv Cookie、代理地址、网格/详情画质档位
- **隐藏作品**：对不感兴趣的推荐一键「不想看」

## 技术栈

- React 19 + Vite 8 + Zustand
- Capacitor（Android，原生文件系统 / 网络请求）
- fflate（ZIP 解帧）、jszip、gifenc（动图编码）

## 开发运行

```bash
npm install
npm run dev
```

打开 http://localhost:5182 。API 走 Vite 开发代理（`/pixiv-api`、`/pixiv-img`、`/pixiv-thumb`、`/pixiv-zip`），
需要本地 HTTP 代理（默认 `http://127.0.0.1:7890`，可在设置里改，或设环境变量 `PROXY_URL`）才能访问 Pixiv。

推荐 / 收藏 / 相关推荐等需要 Cookie：登录 pixiv.net，复制 PHPSESSID，
在应用「我」页右上角 ⚙️ 设置里填入（保存在 localStorage，不进代码）。

## 环境变量

复制 `.env.example` 为 `.env` 可预置 Cookie（设置页填写的值优先）：

```
VITE_PIXIV_COOKIE=your_phpsessid_here
```

代理地址环境变量：`PROXY_URL` / `VITE_PROXY_URL`（默认 `http://127.0.0.1:7890`）。

## 桌面端（Electron）

加装独立桌面 App，壳内自带 Pixiv 代理服务（复用 dev 的同款 4 条中间件），
图片/动图/保存走壳内代理或 `i.pixiv.re`，无需处理 CORS。

```bash
npm run desktop      # 构建 + 启动桌面 App（生产模式，需本地 Clash 在 7890 + 设置页填 Cookie）
npm run desktop:dev  # 桌面壳 + Vite dev server（热更新；需要先另开终端 npm run dev）
npm run desktop:build  # 打包 Windows 安装包/便携版 → release/
```

桌面「保存」通过系统保存对话框写文件（Electron 壳内 IPC），
替代手机端「保存到相册」。启动时代理不可达会弹提示，可在设置里改代理地址。

## Android（Capacitor）

```bash
npm run build
npx cap sync android
npx cap run android   # 需要 Android SDK + 已连接设备
```

构建独立 APK（无需 dev server，默认）：

```bash
npx cap sync android && cd android && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

开发模式（设置 `CAP_DEV=1`）下 WebView 加载局域网 Vite dev server：
把 `capacitor.config.ts` 里的 `server.url`（或 `CAP_DEV_URL`）改成你的电脑局域网 IP，手机与电脑同网即可。
正式打包无需任何环境变量，WebView 从本地 `dist` assets 加载。

## 目录结构

```
src/
├── api/             # 传输适配（dev fetch / prod CapacitorHttp）、动图下载、统一保存入口
├── pages/           # 推荐 / 排行 / 我 / 搜索 / 设置
├── components/      # 网格、灯箱、详情、动图播放器、下载监控等
├── pixiv-assistant/ # 核心业务逻辑与存储层
│   ├── core/        # 纯逻辑（API 工厂、URL 工具、常量），无平台依赖
│   └── capacitor/   # 平台实现（IndexedDB 元数据、文件系统、网络下载、状态机）
├── store/           # Zustand 全局状态
├── context/         # 喜欢 / 缓存状态 Context
├── hooks/           # useTabFeed 等公共钩子
└── utils/           # 返回键、Toast、主题、画质、日志等
scripts/             # Vite 代理中间件（Clash 转发到 Pixiv）
```

更详细的架构说明见 [docs/architecture.md](docs/architecture.md)。

## 说明

- 个人自用工具：Cookie 属于敏感信息，请勿提交到公开仓库。
- 图片代理（`/pixiv-img`、`/pixiv-thumb`）带 7 天 Cache-Control，减少重复下载。

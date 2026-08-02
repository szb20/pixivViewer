# PixivViewer

从 llm-chat 中独立出来的 Pixiv 图片浏览/下载应用（个人自用）。

## 功能

- 推荐 / 排行榜 / 收藏 / 搜索 四个浏览入口（双列网格 + 分页）
- 多图详情页：全部页面上下堆叠、进入视口懒加载原图、本地相册优先
- 全屏灯箱（滑动翻页 / 双击与双指缩放）
- 相关推荐 + 多图浏览历史栈
- Ugoira 动图播放（浏览器端 ZIP 解帧）与保存到相册（gifenc 编码）
- 下载到相册：IndexedDB 元数据 + Capacitor Filesystem 文件
- 本地相册 tab：已下载作品管理

## 开发运行

```bash
npm install
npm run dev
```

打开 http://localhost:5182 。API 走 Vite 开发代理（`/pixiv-api`），
需要本地 HTTP 代理（默认 `http://127.0.0.1:7890`，可在设置里改）才能访问 Pixiv。

推荐 / 收藏 / 相关推荐需要 Cookie：登录 pixiv.net，复制 PHPSESSID，
在应用右上角 ⚙️ 设置里填入（保存在 localStorage，不进代码）。

## Android（Capacitor）

```bash
npm run build
npx cap sync android
npx cap run android   # 需要 Android SDK + 已连接设备
```

开发模式（未设置 `CAP_BUILD`）下 WebView 加载局域网 Vite dev server：
把 `capacitor.config.ts` 里的 `server.url` 改成你的电脑局域网 IP，手机与电脑同网即可。
正式打包：`CAP_BUILD=1 npx cap sync android`，WebView 从本地 assets 加载。

## 说明

- 个人自用工具：Cookie 属于敏感信息，请勿提交到公开仓库。
- 图片代理（/pixiv-img、/pixiv-thumb）带 7 天 Cache-Control，减少重复下载。

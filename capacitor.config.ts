import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pixivviewer.app',
  appName: 'PixivViewer',
  webDir: 'dist',
};

// 开发模式：WebView 加载局域网内的 Vite dev server（带 pixiv 代理）。
// 正式打包：设置 CAP_BUILD=1 后从 webDir 本地文件加载。
if (!process.env.CAP_BUILD) {
  config.server = {
    url: 'http://192.168.1.2:5182',
    cleartext: true,
  };
}

export default config;

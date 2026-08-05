import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pixivviewer.app',
  appName: 'PixivViewer',
  webDir: 'dist',
};

// 默认始终从打包好的本地资源（webDir/dist）加载，避免误把 dev server 地址打进正式包。
// 开发模式：显式设置 CAP_DEV=1 时，WebView 才加载局域网内的 Vite dev server（带 pixiv 代理）。
if (process.env.CAP_DEV === '1') {
  config.server = {
    url: 'http://192.168.1.2:5182',
    cleartext: true,
  };
}

export default config;

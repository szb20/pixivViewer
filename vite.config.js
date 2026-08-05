import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { registerPixivProxies } from './scripts/pixiv-proxy.mjs';
import { checkProxyAvailability } from './scripts/proxy-utils.mjs';

// https://vite.dev/config/
export default defineConfig({
  base: './',
  // Vite 8 cssMinify 走 lightningcss，其 targets 取 build.cssTarget；
  // 默认是 esbuild 基线（含 safari14），会给 backdrop-filter 加 -webkit- 前缀
  // （部分安卓 WebView 上会使标准属性失效）。改为现代 Chrome 目标，不再加前缀。
  build: {
    cssTarget: 'chrome110',
  },
  plugins: [
    react(),
    {
      name: 'pixiv-proxy',
      configureServer(server) {
        // 检查代理可用性（Pixiv API/图片需要走代理，同 llm-chat 的 dev 方案）
        checkProxyAvailability();
        registerPixivProxies(server);
      },
    },
  ],
  server: {
    port: 5182,
    host: '0.0.0.0',
    strictPort: true,
  },
});

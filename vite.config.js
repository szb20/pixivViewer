import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { registerPixivProxies } from './scripts/pixiv-proxy.mjs';
import { checkProxyAvailability } from './scripts/proxy-utils.mjs';

// https://vite.dev/config/
export default defineConfig({
  base: './',
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
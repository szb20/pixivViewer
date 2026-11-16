import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 与源码同目录存放：*.test.js 不会被 Vite 打进产物（没有入口引用它们）
    include: ['src/**/*.test.js'],
    setupFiles: ['src/test/setup.js'],
  },
});

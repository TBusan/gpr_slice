// vitest.config.js —— 纯逻辑单测（node 环境；three.js 可在 node 下 import）
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/bench-reservation/boundary-http.spec.ts'],
    fileParallelism: false,
    testTimeout: 5000,
    hookTimeout: 30000,
  },
  plugins: [swc.vite()],
});

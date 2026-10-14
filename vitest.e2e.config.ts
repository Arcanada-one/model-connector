import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: process.env.MC_DISPOSABLE_APP_E2E === '1' ? '/tmp/mc-app-e2e-vite' : undefined,
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: process.env.MC_DISPOSABLE_APP_E2E === '1' ? ['test/app-e2e-no-egress.mjs'] : [],
    testTimeout: 30_000,
  },
  plugins: [swc.vite()],
});

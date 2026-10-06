import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', './scripts/ci/vitest-profile-reporter.mjs'],
    globals: true,
    root: './',
    include: [
      'src/**/*.spec.ts',
      'test/watcher/**/*.spec.ts',
      'scripts/**/*.spec.mjs',
      'test/bench-reservation/boundary-http.spec.ts',
      'test/bench-reservation/bootstrap-source.spec.ts',
    ],
    // Exclude integration tests from default run — use pnpm test:integration instead
    exclude: ['src/**/*.integration.spec.ts', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.integration.spec.ts',
        'src/**/*.module.ts',
        'src/main.ts',
      ],
    },
  },
  plugins: [swc.vite()],
});

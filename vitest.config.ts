import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', './scripts/ci/vitest-profile-reporter.mjs'],
    globals: true,
    root: './',
    // Cold Nest module graphs (CascadeModule DI, AppModule probes) exceed the
    // Vitest default 10s hookTimeout under host contention and surface as an
    // empty beforeAll failure in the JSON reporter. Keep the budget explicit.
    hookTimeout: 60_000,
    include: [
      'src/**/*.spec.ts',
      'test/watcher/**/*.spec.ts',
      'test/provider-profiles/**/*.spec.ts',
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

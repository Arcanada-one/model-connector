import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Source-only fixtures: never load .env.integration or existing provider specs.
export default defineConfig({
  test: {
    include: [
      'src/bench-reservation/authority.spec.ts',
      'src/bench-reservation/postgres.integration.spec.ts',
    ],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [swc.vite()],
});

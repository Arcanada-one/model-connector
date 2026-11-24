import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

if (!process.env.BILLING_CUSTODIAN_SOURCE) {
  throw new Error('BILLING_CUSTODIAN_SOURCE must name the pinned Billing3a source snapshot');
}

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/bench-reservation/journal-bridge.billing3a.integration.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  plugins: [swc.vite()],
});

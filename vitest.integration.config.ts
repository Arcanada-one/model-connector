import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Parse .env.integration into a Record<string,string>.
 * Handles multi-line JSON values (e.g. VERTEX_SERVICE_ACCOUNT_JSON).
 * Lines starting with # are comments; empty lines are skipped.
 * Handles KEY=value where value may contain = signs.
 */
function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf8');
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1); // preserve everything after first =
    if (key) result[key] = value;
  }
  return result;
}

const envVars = loadEnvFile(join(process.cwd(), '.env.integration'));
const billing3aSpec = 'src/bench-reservation/journal-bridge.billing3a.integration.spec.ts';
const billing3aJournalOnly = process.env.MC_BILLING3A_JOURNAL_ONLY === '1';

if (billing3aJournalOnly && !process.env.BILLING_CUSTODIAN_SOURCE) {
  throw new Error('BILLING_CUSTODIAN_SOURCE must name the pinned Billing3a source snapshot');
}

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: billing3aJournalOnly ? [billing3aSpec] : ['src/**/*.integration.spec.ts'],
    exclude: billing3aJournalOnly ? [] : [billing3aSpec],
    // Integration tests hit real APIs — allow up to 60s per test
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run serially to avoid parallel Vertex quota hits
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    env: envVars,
  },
  plugins: [swc.vite()],
});

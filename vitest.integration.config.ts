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

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.integration.spec.ts'],
    // Integration tests hit real APIs — allow up to 60s per test
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run serially to avoid parallel Vertex quota hits
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    env: envVars,
  },
  plugins: [swc.vite()],
});

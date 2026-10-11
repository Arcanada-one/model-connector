import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ entries: 0, connects: 0 }));
vi.mock('../../src/prisma/prisma.service', () => ({
  PrismaService: class {
    async $connect() {
      state.connects++;
    }
    async $disconnect() {}
    apiKey = { findUnique: async () => ({ active: true, name: 'df60-disposable-offline' }) };
  },
}));
vi.mock('./df60-composition', () => ({
  runComposedDiagnostic: async () => {
    state.entries++;
    return { raw: true };
  },
}));
import { main } from './df60-raw-cli';
describe('output custody before App and DB entry (synthetic controls only)', () => {
  it.each([true, false])('occupied=%s preserves history and controls entry', async (occupied) => {
    const dir = await mkdtemp(join(homedir(), 'mc-diag-output-'));
    const old = { DATABASE_URL: process.env.DATABASE_URL, MC_NO_EGRESS: process.env.MC_NO_EGRESS };
    state.entries = 0;
    state.connects = 0;
    try {
      const raw = JSON.stringify({
        id: 'case',
        request: { prompt: 'fixture' },
        stdout: '{}',
        stderr: '',
        exitCode: 0,
        fault: 'none',
      });
      const input = join(dir, 'input.json'),
        output = join(dir, 'output.json');
      await writeFile(input, raw);
      if (occupied) await writeFile(output, 'historical output');
      process.env.DATABASE_URL = 'postgresql://test:test@mc-diag-pg/diag_df60';
      process.env.MC_NO_EGRESS = '1';
      const operation = main([
        input,
        createHash('sha256').update(raw).digest('hex'),
        output,
        'own-key',
      ]);
      if (occupied) {
        await expect(operation).rejects.toThrow();
        expect(await readFile(output, 'utf8')).toBe('historical output');
      } else {
        await operation;
        expect(JSON.parse(await readFile(output, 'utf8')).accountingAdmission).toBe('NOT_MEASURED');
      }
      expect(state.entries).toBe(occupied ? 0 : 1);
      expect(state.connects).toBe(occupied ? 0 : 1);
    } finally {
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(dir, { recursive: true });
    }
  });
});

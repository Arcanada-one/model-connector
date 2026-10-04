import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit-log.js';
import { StateStore } from '../src/state-store.js';

describe('state and audit persistence', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mc-state-audit-'));
  });

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('isolates state fixtures in a private directory under the caller temporary root', async () => {
    expect(join(directory, '..')).toBe(tmpdir());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(directory)).isSymbolicLink()).toBe(false);
  });

  it('writes state atomically with mode 0600', async () => {
    const path = join(directory, `watcher-${crypto.randomUUID()}.json`);
    const store = new StateStore(path);
    await store.write({ heartbeatAt: '2026-01-01T00:00:00.000Z' });
    expect(JSON.parse(await readFile(path, 'utf8')).heartbeatAt).toContain('2026');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
  });

  it('rejects malformed and symlink state targets', async () => {
    const target = join(directory, `watcher-target-${crypto.randomUUID()}`);
    const link = join(directory, `watcher-link-${crypto.randomUUID()}`);
    await writeFile(target, '{}', { mode: 0o600 });
    await symlink(target, link);
    await expect(new StateStore(link).write({ ok: true })).rejects.toThrow(/symlink/);
    await writeFile(target, '{broken', { mode: 0o600 });
    await expect(new StateStore(target).read()).rejects.toThrow(/malformed/);
  });

  it('appends mandatory audit fields', async () => {
    const path = join(directory, `watcher-audit-${crypto.randomUUID()}.jsonl`);
    const audit = new AuditLog(path);
    await audit.append({
      audit_ref: 'a-1',
      component: 'recovery',
      level_attempted: 'L2',
      fix_applied: false,
      outcome: 'blocked',
    });
    const row = JSON.parse((await readFile(path, 'utf8')).trim());
    expect(Object.keys(row)).toEqual(
      expect.arrayContaining(['timestamp', 'audit_ref', 'component', 'level_attempted', 'fix_applied', 'outcome']),
    );
  });

  it('preserves the last valid state when serialization fails before rename', async () => {
    const path = join(directory, `watcher-preserve-${crypto.randomUUID()}.json`);
    const store = new StateStore<Record<string, unknown>>(path);
    await store.write({ generation: 1 });
    await expect(store.write({ invalid: 1n })).rejects.toThrow();
    expect(await store.read()).toEqual({ generation: 1 });
  });

  it('serializes concurrent writes without producing malformed state', async () => {
    const path = join(directory, `watcher-concurrent-${crypto.randomUUID()}.json`);
    const store = new StateStore<{ generation: number }>(path);
    await Promise.all(Array.from({ length: 10 }, (_, generation) => store.write({ generation })));
    expect((await store.read())?.generation).toBe(9);
  });
});

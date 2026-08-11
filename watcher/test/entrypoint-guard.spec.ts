import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { isDirectlyExecuted } from '../src/main.js';

describe('isDirectlyExecuted', () => {
  it('returns false when argv1 is undefined', () => {
    expect(isDirectlyExecuted(undefined, import.meta.url)).toBe(false);
  });

  it('returns false when argv1 is empty string', () => {
    expect(isDirectlyExecuted('', import.meta.url)).toBe(false);
  });

  it('returns true when argv1 is the real path of the module', () => {
    const selfReal = realpathSync(fileURLToPath(import.meta.url));
    expect(isDirectlyExecuted(selfReal, import.meta.url)).toBe(true);
  });

  it('returns false when argv1 points to a different real file', () => {
    expect(isDirectlyExecuted('/usr/bin/node', import.meta.url)).toBe(false);
  });

  describe('symlink resolution', () => {
    let tempDir: string;
    let symlinkPath: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'conn-0230-guard-'));
      const selfReal = realpathSync(fileURLToPath(import.meta.url));
      symlinkPath = join(tempDir, 'current-main.js');
      await symlink(selfReal, symlinkPath);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('returns true when argv1 is a symlink pointing to the real module file', () => {
      // This is the production scenario: systemd ExecStart uses .../current/dist/src/main.js
      // where "current" is a symlink to releases/<date>/. Node's import.meta.url is the
      // resolved real path, but process.argv[1] stays the symlink path — they must match.
      expect(isDirectlyExecuted(symlinkPath, import.meta.url)).toBe(true);
    });
  });
});

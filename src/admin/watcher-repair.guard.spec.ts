import { ExecutionContext } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WatcherRepairGuard } from './watcher-repair.guard';

function context(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('WatcherRepairGuard', () => {
  const token = 'w'.repeat(32);

  beforeEach(() => {
    process.env.WATCHER_REPAIR_TOKEN = token;
  });

  afterEach(() => {
    delete process.env.WATCHER_REPAIR_TOKEN;
  });

  it('accepts only the dedicated watcher token header', () => {
    expect(new WatcherRepairGuard().canActivate(context({ 'x-watcher-repair-token': token }))).toBe(
      true,
    );
  });

  it.each([{}, { 'x-watcher-repair-token': 'wrong' }, { 'x-admin-token': token }])(
    'rejects missing, wrong, or broad admin credentials',
    (headers) => {
      expect(new WatcherRepairGuard().canActivate(context(headers))).toBe(false);
    },
  );

  /**
   * ARAS-0058 (consilium §6.2) — this guard was the THIRD copy of the
   * byte-length crash-oracle. The consilium named `AdminGuard` and
   * `StatsReadGuard`; this one had it too, uncited. Fails on the pre-fix code.
   */
  it('does not crash on a multi-byte token of equal string length (crash-oracle)', () => {
    const oracle = 'é' + 'w'.repeat(31);
    expect(oracle.length).toBe(token.length);

    const guard = new WatcherRepairGuard();
    const ctx = context({ 'x-watcher-repair-token': oracle });
    expect(() => guard.canActivate(ctx)).not.toThrow();
    expect(guard.canActivate(ctx)).toBe(false);
  });
});

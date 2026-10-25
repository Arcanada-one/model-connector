import { describe, expect, it, vi } from 'vitest';
import ProfileReporter, { profileObservation } from './vitest-profile-reporter.mjs';
import { observeAsync, observeSync } from './test-phase-observation';

describe('additive test observations', () => {
  it('keeps only resolved allowlisted configuration and never invents worker count', () => {
    expect(profileObservation({ config: { pool: 'threads', isolate: true } }, 16, false)).toEqual({
      cpu: 16,
      overridePresent: false,
      projects: [{ pool: 'threads', maxWorkers: null, isolate: true }],
    });
    expect(
      profileObservation(
        {
          config: { maxWorkers: 8 },
          projects: [{ config: { pool: 'forks', maxWorkers: 2, isolate: false } }],
        },
        16,
        true,
      ).projects,
    ).toEqual([{ pool: 'forks', maxWorkers: 2, isolate: false }]);
  });

  it('refuses to serialize unrelated, malformed or secret-bearing metadata', () => {
    const result = profileObservation(
      {
        config: {
          pool: 'SENTINEL_PRIVATE',
          maxWorkers: 'SENTINEL_PRIVATE',
          isolate: 'SENTINEL_PRIVATE',
          env: { password: 'SENTINEL_PRIVATE' },
          root: 'SENTINEL_PRIVATE',
        },
      },
      NaN,
      'SENTINEL_PRIVATE',
    );
    expect(result).toEqual({
      cpu: null,
      overridePresent: false,
      projects: [{ pool: null, maxWorkers: null, isolate: null }],
    });
    expect(JSON.stringify(result)).not.toContain('SENTINEL_PRIVATE');
  });

  it('uses the maintained reporter hook without changing configuration', () => {
    const ctx = { config: { pool: 'threads', maxWorkers: 2, isolate: true } };
    const before = JSON.stringify(ctx);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      new ProfileReporter().onInit(ctx);
      expect(JSON.stringify(ctx)).toBe(before);
      expect(log.mock.calls[0][0]).toBe('MC_TEST_PROFILE');
      expect(JSON.parse(log.mock.calls[0][1]).projects[0].maxWorkers).toBe(2);
    } finally {
      log.mockRestore();
    }
  });

  it('preserves sync/async values and exact thrown identity without logging bodies', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const value = { private: 'SENTINEL_PRIVATE' };
    const failure = new Error('SENTINEL_PRIVATE');
    try {
      expect(observeSync('fixture-construction', () => value)).toBe(value);
      expect(await observeAsync('memory-execute', async () => value)).toBe(value);
      expect(() =>
        observeSync('fixture-construction', () => {
          throw failure;
        }),
      ).toThrow(failure);
      await expect(
        observeAsync('memory-execute', async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(log).toHaveBeenCalledTimes(4);
      expect(JSON.stringify(log.mock.calls)).not.toContain('SENTINEL_PRIVATE');
      for (const [, body] of log.mock.calls) {
        expect(Object.keys(JSON.parse(body)).sort()).toEqual([
          'cpuSystemUs',
          'cpuUserUs',
          'phase',
          'wallMs',
        ]);
      }
    } finally {
      log.mockRestore();
    }
  });

  it('rejects unknown phase labels before running an operation', () => {
    const operation = vi.fn();
    expect(() => observeSync('SENTINEL_PRIVATE', operation)).toThrow('unsupported_test_phase');
    expect(operation).not.toHaveBeenCalled();
  });

  it('cannot replace a business result/error when the diagnostic sink fails', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('sink unavailable');
    });
    const failure = new Error('business failure');
    try {
      expect(observeSync('memory-execute', () => 7)).toBe(7);
      await expect(
        observeAsync('memory-execute', async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(() => new ProfileReporter().onInit({ config: {} })).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });
});

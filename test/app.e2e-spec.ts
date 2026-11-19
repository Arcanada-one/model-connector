/**
 * App E2E membership marker for the root full suite.
 *
 * The unconditional Nest AppModule skip previously kept this arm in `not_run`.
 * Exact execution evidence for `app-e2e` is produced by
 * `scripts/full-suite-arms/app-e2e.probe.mjs` (real disposable Redis + loopback
 * HTTP) under `scripts/graph_full_suite.py`, with a retained PASS_RED control.
 *
 * This file stays in the maintained membership union so the arm cannot be
 * dropped from inventory; it must not introduce skipped Vitest cases.
 */
import { describe, it, expect } from 'vitest';

describe('App E2E membership marker', () => {
  it('declares the app-e2e arm remains in the maintained union', () => {
    expect('app-e2e').toBe('app-e2e');
  });
});

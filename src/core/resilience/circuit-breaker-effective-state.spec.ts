import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from './circuit-breaker';
import { CircuitBreakerManager } from './circuit-breaker-manager';

/**
 * A2-210 — `getState()` reported the STORED state, and the `open -> half_open`
 * transition happened only inside `check()`. On an idle model nobody calls
 * `check()`, so the breaker stayed `open` for as long as no traffic arrived.
 *
 * Measured on the live service (A2-206): `deepseek-flash` reported
 * `{"state":"open","consecutiveFailures":5,"nextRetryAt": <997 s in the past>}`
 * and the very next real request succeeded on the first attempt.
 *
 * Two readers paid for it:
 *   - `GET /connectors/:name/status` showed a stuck breaker (false alarm);
 *   - `ConnectorsService` marks a model unavailable in the catalog when
 *     `circuitBreakers[model].state === 'open'` (connectors.service.ts), so an
 *     idle model stayed *unavailable* past its own cooldown.
 *
 * The existing suite missed it because every half_open assertion calls
 * `check()` first — which performs the transition it then observes.
 *
 * Note: the assertions below never call `check()`. That is the point.
 */
describe('A2-210 — CircuitBreaker.getState() reports the EFFECTIVE state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const opened = (threshold = 3, cooldownMs = 1_000) => {
    const cb = new CircuitBreaker(threshold, cooldownMs, 'probe:model');
    for (let i = 0; i < threshold; i++) cb.recordFailure('timeout');
    return cb;
  };

  it('is still `open` inside the cooldown, with nextRetryAt in the future', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cb = opened();

    vi.advanceTimersByTime(500);

    const state = cb.getState();
    expect(state.state).toBe('open');
    expect(state.nextRetryAt).toBe(new Date('2026-01-01T00:00:00Z').getTime() + 1_000);
  });

  it('reports `half_open` once the cooldown has elapsed, without any call', () => {
    const cb = opened();

    vi.advanceTimersByTime(1_001);

    expect(cb.getState().state).toBe('half_open');
  });

  it('drops nextRetryAt once the cooldown has elapsed — there is nothing to wait for', () => {
    const cb = opened();

    vi.advanceTimersByTime(1_001);

    expect(cb.getState().nextRetryAt).toBeUndefined();
  });

  it('agrees with check(): the state it reports is the one the next call gets', () => {
    const cb = opened();
    vi.advanceTimersByTime(1_001);

    const reported = cb.getState().state;
    expect(() => cb.check()).not.toThrow();
    expect(reported).toBe('half_open');
    expect(cb.getState().state).toBe('half_open');
  });

  it('reads do not mutate: getState() is not what performs the transition', () => {
    const cb = opened();
    vi.advanceTimersByTime(1_001);

    cb.getState();
    // Still stored as `open`; a failure now must re-open from `open`, not be
    // treated as a failed half_open probe by a read that nobody asked for.
    cb.recordFailure('server_error');
    expect(cb.getState().state).toBe('open');
    expect(cb.getState().consecutiveFailures).toBe(4);
  });

  it('keeps the other fields intact', () => {
    const cb = opened();
    vi.advanceTimersByTime(1_001);

    const state = cb.getState();
    expect(state.consecutiveFailures).toBe(3);
    expect(state.lastErrorType).toBe('timeout');
  });

  it('an elapsed cooldown does not resurrect a closed breaker', () => {
    const cb = new CircuitBreaker(3, 1_000, 'probe:model');
    cb.recordFailure('timeout');
    vi.advanceTimersByTime(5_000);
    expect(cb.getState().state).toBe('closed');
  });
});

describe('A2-210 — the manager and its readers see the effective state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('perModel and aggregate both stop claiming `open` after the cooldown', () => {
    const mgr = new CircuitBreakerManager('probe', 3, 1_000);
    const cb = mgr.getCircuitBreaker('idle-model');
    for (let i = 0; i < 3; i++) cb.recordFailure('timeout');

    expect(mgr.getStates().aggregate.state).toBe('open');

    vi.advanceTimersByTime(1_001);

    const { aggregate, perModel } = mgr.getStates();
    expect(perModel['idle-model'].state).toBe('half_open');
    // `healthy: aggregate.state !== 'open'` (base-cli.connector.ts, base-stt)
    // and the catalog's `modelBreakerOpen` both key on exactly this string.
    expect(aggregate.state).toBe('half_open');
  });

  it('resetModel reports the state the operator was actually looking at', () => {
    const mgr = new CircuitBreakerManager('probe', 3, 1_000);
    const cb = mgr.getCircuitBreaker('idle-model');
    for (let i = 0; i < 3; i++) cb.recordFailure('timeout');

    vi.advanceTimersByTime(1_001);

    expect(mgr.resetModel('idle-model')).toEqual({
      model: 'idle-model',
      previousState: 'half_open',
    });
  });

  it('a breaker still inside its cooldown is still aggregated as open', () => {
    const mgr = new CircuitBreakerManager('probe', 3, 1_000);
    const cb = mgr.getCircuitBreaker('sick-model');
    for (let i = 0; i < 3; i++) cb.recordFailure('timeout');

    vi.advanceTimersByTime(500);

    expect(mgr.getStates().aggregate.state).toBe('open');
  });
});

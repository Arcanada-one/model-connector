import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker(3, 1000); // threshold=3, cooldown=1s
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start in closed state', () => {
    expect(cb.getState().state).toBe('closed');
    expect(cb.getState().consecutiveFailures).toBe(0);
  });

  it('should allow requests in closed state', () => {
    expect(() => cb.check()).not.toThrow();
  });

  it('should count consecutive failures', () => {
    cb.recordFailure('timeout');
    expect(cb.getState().consecutiveFailures).toBe(1);
    expect(cb.getState().state).toBe('closed');

    cb.recordFailure('timeout');
    expect(cb.getState().consecutiveFailures).toBe(2);
    expect(cb.getState().state).toBe('closed');
  });

  it('should open after threshold failures', () => {
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');
    expect(cb.getState().state).toBe('open');
  });

  it('should reject requests when open', () => {
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');

    expect(() => cb.check()).toThrow(CircuitOpenError);
  });

  it('should transition to half_open after cooldown', () => {
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');

    vi.advanceTimersByTime(1001);

    expect(() => cb.check()).not.toThrow();
    expect(cb.getState().state).toBe('half_open');
  });

  it('should close on success in half_open', () => {
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');

    vi.advanceTimersByTime(1001);
    cb.check(); // transitions to half_open

    cb.recordSuccess();
    expect(cb.getState().state).toBe('closed');
    expect(cb.getState().consecutiveFailures).toBe(0);
  });

  it('should re-open on failure in half_open', () => {
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');

    vi.advanceTimersByTime(1001);
    cb.check(); // transitions to half_open

    cb.recordFailure('server_error');
    expect(cb.getState().state).toBe('open');
  });

  it('should reset failure count on success', () => {
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');
    cb.recordSuccess();
    expect(cb.getState().consecutiveFailures).toBe(0);
    expect(cb.getState().state).toBe('closed');
  });

  it('should instant-open on auth_error', () => {
    cb.recordFailure('auth_error');
    expect(cb.getState().state).toBe('open');
    expect(cb.getState().consecutiveFailures).toBe(3); // set to threshold
  });

  it('should instant-open on binary_not_found', () => {
    cb.recordFailure('binary_not_found');
    expect(cb.getState().state).toBe('open');
  });

  it('should include nextRetryAt when open', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    cb.recordFailure('auth_error');
    const state = cb.getState();
    expect(state.nextRetryAt).toBeDefined();
    expect(state.nextRetryAt).toBe(new Date('2026-01-01T00:00:00Z').getTime() + 1000);
  });

  it('should not include nextRetryAt when closed', () => {
    expect(cb.getState().nextRetryAt).toBeUndefined();
  });

  it('should reset to initial state', () => {
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');
    cb.recordFailure('timeout');
    cb.reset();
    expect(cb.getState().state).toBe('closed');
    expect(cb.getState().consecutiveFailures).toBe(0);
  });

  it('should track lastErrorType after failure', () => {
    expect(cb.getState().lastErrorType).toBeNull();
    cb.recordFailure('auth_error');
    expect(cb.getState().lastErrorType).toBe('auth_error');
  });

  it('should clear lastErrorType after reset', () => {
    cb.recordFailure('timeout');
    cb.reset();
    expect(cb.getState().lastErrorType).toBeNull();
  });

  it('should clear lastErrorType after success', () => {
    cb.recordFailure('timeout');
    cb.recordSuccess();
    expect(cb.getState().lastErrorType).toBeNull();
  });
});

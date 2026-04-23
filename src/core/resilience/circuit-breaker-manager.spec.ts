import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreakerManager } from './circuit-breaker-manager';

describe('CircuitBreakerManager', () => {
  let manager: CircuitBreakerManager;

  beforeEach(() => {
    manager = new CircuitBreakerManager('test-connector', 3, 1000);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should lazily create a circuit breaker for a model', () => {
    const cb = manager.getCircuitBreaker('gpt-4');
    expect(cb).toBeDefined();
    expect(cb.getState().state).toBe('closed');
  });

  it('should return the same circuit breaker for the same model', () => {
    const cb1 = manager.getCircuitBreaker('gpt-4');
    const cb2 = manager.getCircuitBreaker('gpt-4');
    expect(cb1).toBe(cb2);
  });

  it('should return different circuit breakers for different models', () => {
    const cb1 = manager.getCircuitBreaker('gpt-4');
    const cb2 = manager.getCircuitBreaker('claude-3');
    expect(cb1).not.toBe(cb2);
  });

  it('should use "default" key for empty model string', () => {
    const cb1 = manager.getCircuitBreaker('');
    const cb2 = manager.getCircuitBreaker('');
    expect(cb1).toBe(cb2);
  });

  describe('getStates', () => {
    it('should return empty states when no circuit breakers exist', () => {
      const { aggregate, perModel } = manager.getStates();
      expect(aggregate.state).toBe('closed');
      expect(aggregate.consecutiveFailures).toBe(0);
      expect(aggregate.lastErrorType).toBeNull();
      expect(Object.keys(perModel)).toHaveLength(0);
    });

    it('should aggregate states from multiple models', () => {
      const cb1 = manager.getCircuitBreaker('model-a');
      const cb2 = manager.getCircuitBreaker('model-b');

      cb1.recordFailure('timeout');
      cb2.recordFailure('timeout');
      cb2.recordFailure('network_error');

      const { aggregate, perModel } = manager.getStates();
      expect(aggregate.consecutiveFailures).toBe(3);
      expect(aggregate.state).toBe('closed');
      expect(Object.keys(perModel)).toHaveLength(2);
      expect(perModel['model-a'].consecutiveFailures).toBe(1);
      expect(perModel['model-b'].consecutiveFailures).toBe(2);
    });

    it('should report worst-case state as open when any model is open', () => {
      const cb1 = manager.getCircuitBreaker('model-a');
      manager.getCircuitBreaker('model-b');

      // Open model-a (threshold=3)
      cb1.recordFailure('timeout');
      cb1.recordFailure('timeout');
      cb1.recordFailure('timeout');

      const { aggregate } = manager.getStates();
      expect(aggregate.state).toBe('open');
    });

    it('should report half_open as worst when no model is open', () => {
      const cb1 = manager.getCircuitBreaker('model-a');
      manager.getCircuitBreaker('model-b');

      // Open then transition to half_open
      cb1.recordFailure('timeout');
      cb1.recordFailure('timeout');
      cb1.recordFailure('timeout');
      vi.advanceTimersByTime(1001);
      cb1.check(); // transitions to half_open

      const { aggregate } = manager.getStates();
      expect(aggregate.state).toBe('half_open');
    });

    it('should track lastErrorType from the last failing model', () => {
      const cb1 = manager.getCircuitBreaker('model-a');
      const cb2 = manager.getCircuitBreaker('model-b');

      cb1.recordFailure('timeout');
      cb2.recordFailure('auth_error');

      const { aggregate } = manager.getStates();
      expect(aggregate.lastErrorType).not.toBeNull();
    });
  });
});

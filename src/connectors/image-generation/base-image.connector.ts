import { CircuitBreakerManager } from '../../core/resilience/circuit-breaker-manager';
import type { ImageGenerationRequest, ImageGenerationResult } from './types';

/**
 * Abstract base for all image-generation provider connectors.
 * Handles circuit-breaker wrapping; subclasses implement `generate`.
 */
export abstract class BaseImageConnector {
  protected readonly cbManager: CircuitBreakerManager;

  constructor(cbManager: CircuitBreakerManager) {
    this.cbManager = cbManager;
  }

  /**
   * Subclasses implement the provider-specific generation logic.
   */
  abstract generate(req: ImageGenerationRequest): Promise<ImageGenerationResult>;

  /**
   * Wraps `fn` with circuit-breaker check + success/failure recording.
   * @param modelKey  The circuit key (e.g. 'vertex:imagen-4')
   * @param fn        Async factory that calls the provider
   */
  protected async withCircuit<T>(modelKey: string, fn: () => Promise<T>): Promise<T> {
    const cb = this.cbManager.getCircuitBreaker(modelKey);
    cb.check(); // throws CircuitOpenError if open
    try {
      const result = await fn();
      cb.recordSuccess();
      return result;
    } catch (err) {
      // Classify error as a simple string for circuit breaker recording
      const message = err instanceof Error ? err.message : 'unknown';
      const errorType = message.includes('auth') ? 'auth_error' : 'server_error';
      cb.recordFailure(errorType);
      throw err;
    }
  }

  /**
   * Public alias for `withCircuit` — exposed so test subclasses can call it
   * without needing `protected` access workarounds.
   */
  withCircuitPublic<T>(modelKey: string, fn: () => Promise<T>): Promise<T> {
    return this.withCircuit(modelKey, fn);
  }
}

import { CircuitBreaker, type CircuitState } from './circuit-breaker';

export interface CircuitBreakerResetResult {
  model: string;
  previousState: CircuitState;
}

export class CircuitBreakerManager {
  private _circuitBreakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly connectorName: string,
    private readonly threshold: number = 5,
    private readonly cooldownMs: number = 30_000,
  ) {}

  getCircuitBreaker(model: string): CircuitBreaker {
    const key = model || 'default';
    let cb = this._circuitBreakers.get(key);
    if (!cb) {
      cb = new CircuitBreaker(this.threshold, this.cooldownMs, `${this.connectorName}:${key}`);
      this._circuitBreakers.set(key, cb);
    }
    return cb;
  }

  resetAll(): CircuitBreakerResetResult[] {
    const results: CircuitBreakerResetResult[] = [];
    for (const [model, cb] of this._circuitBreakers) {
      results.push({ model, previousState: cb.getState().state });
      cb.reset();
    }
    return results;
  }

  resetModel(model: string): CircuitBreakerResetResult | null {
    const key = model || 'default';
    const cb = this._circuitBreakers.get(key);
    if (!cb) return null;
    const previousState = cb.getState().state;
    cb.reset();
    return { model: key, previousState };
  }

  getStates(): {
    aggregate: {
      state: CircuitState;
      consecutiveFailures: number;
      lastErrorType: string | null;
    };
    perModel: Record<string, ReturnType<CircuitBreaker['getState']>>;
  } {
    const perModel: Record<string, ReturnType<CircuitBreaker['getState']>> = {};
    let worstState: CircuitState = 'closed';
    let totalFailures = 0;
    let lastError: string | null = null;

    for (const [model, cb] of this._circuitBreakers) {
      const s = cb.getState();
      perModel[model] = s;
      totalFailures += s.consecutiveFailures;
      if (s.lastErrorType) lastError = s.lastErrorType;
      if (s.state === 'open') worstState = 'open';
      else if (s.state === 'half_open' && worstState !== 'open') worstState = 'half_open';
    }

    return {
      aggregate: {
        state: worstState,
        consecutiveFailures: totalFailures,
        lastErrorType: lastError,
      },
      perModel,
    };
  }
}

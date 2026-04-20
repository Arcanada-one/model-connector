export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitOpenError extends Error {
  constructor(
    public readonly connectorName: string,
    public readonly nextRetryAt: number,
  ) {
    super(`Circuit breaker open for ${connectorName}`);
    this.name = 'CircuitOpenError';
  }
}

const INSTANT_OPEN_ERRORS = new Set(['auth_error', 'binary_not_found']);

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private lastErrorType: string | null = null;

  constructor(
    private readonly threshold: number = 5,
    private readonly cooldownMs: number = 30_000,
    private readonly connectorName: string = 'unknown',
  ) {}

  check(): void {
    if (this.state === 'closed') return;

    if (this.state === 'open') {
      if (Date.now() > this.lastFailureTime + this.cooldownMs) {
        this.state = 'half_open';
        return;
      }
      throw new CircuitOpenError(this.connectorName, this.lastFailureTime + this.cooldownMs);
    }

    // half_open — allow one probe request
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastErrorType = null;
    this.state = 'closed';
  }

  recordFailure(errorType: string): void {
    this.lastFailureTime = Date.now();
    this.lastErrorType = errorType;

    if (INSTANT_OPEN_ERRORS.has(errorType)) {
      this.consecutiveFailures = this.threshold;
      this.state = 'open';
      return;
    }

    this.consecutiveFailures++;
    if (this.state === 'half_open' || this.consecutiveFailures >= this.threshold) {
      this.state = 'open';
    }
  }

  getState(): {
    state: CircuitState;
    consecutiveFailures: number;
    nextRetryAt?: number;
    lastErrorType: string | null;
  } {
    const result: {
      state: CircuitState;
      consecutiveFailures: number;
      nextRetryAt?: number;
      lastErrorType: string | null;
    } = {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastErrorType: this.lastErrorType,
    };

    if (this.state === 'open') {
      result.nextRetryAt = this.lastFailureTime + this.cooldownMs;
    }

    return result;
  }

  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.lastErrorType = null;
  }
}

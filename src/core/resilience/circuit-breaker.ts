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

  /** True once the cooldown that followed the last failure has elapsed. */
  private cooldownElapsed(): boolean {
    return Date.now() > this.lastFailureTime + this.cooldownMs;
  }

  /**
   * A2-210 — the state the NEXT call would meet, which is not always the state
   * we stored. `open` decays into `half_open` by the passage of time alone; the
   * stored field only learns that when {@link check} runs. See {@link getState}.
   */
  private effectiveState(): CircuitState {
    if (this.state === 'open' && this.cooldownElapsed()) return 'half_open';
    return this.state;
  }

  check(): void {
    if (this.state === 'closed') return;

    if (this.state === 'open') {
      if (this.cooldownElapsed()) {
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

  /**
   * A2-210 — reports the EFFECTIVE state: what the next call would actually
   * meet, not what the last call happened to leave behind.
   *
   * This used to return the stored field, and `open -> half_open` was performed
   * only inside {@link check}. On an idle model nobody calls `check`, so the
   * breaker was reported `open` for as long as no traffic arrived. Measured on
   * the live service (A2-206): `deepseek-flash` reported
   * `{state: 'open', consecutiveFailures: 5, nextRetryAt: <997 s in the past>}`
   * and the very next real request succeeded on the first attempt.
   *
   * Two readers believed it: `GET /connectors/:name/status` (a stuck breaker on
   * a healthy model) and `ConnectorsService`, which marks a model unavailable
   * in the catalog while `circuitBreakers[model].state === 'open'` — so an idle
   * model stayed unavailable past its own cooldown.
   *
   * The read stays a READ: it does not perform the transition. `check()` is
   * still the only writer, because a monitor polling this endpoint must not
   * spend the half_open probe that the next real request is entitled to.
   *
   * `nextRetryAt` follows the same truth: once the cooldown has elapsed there
   * is nothing left to wait for, so the field is omitted rather than pointing
   * into the past.
   */
  getState(): {
    state: CircuitState;
    consecutiveFailures: number;
    nextRetryAt?: number;
    lastErrorType: string | null;
  } {
    const state = this.effectiveState();
    const result: {
      state: CircuitState;
      consecutiveFailures: number;
      nextRetryAt?: number;
      lastErrorType: string | null;
    } = {
      state,
      consecutiveFailures: this.consecutiveFailures,
      lastErrorType: this.lastErrorType,
    };

    if (state === 'open') {
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

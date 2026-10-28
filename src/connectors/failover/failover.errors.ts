// CONN-0243 — failover gateway error types.

export interface FailoverAttempt {
  connector: string;
  model: string;
  errorType: string;
}

/**
 * Thrown when the free-first failover chain has tried every candidate and none
 * produced a successful completion (all rate-limited / errored / exhausted), or
 * an abort-class error stopped the chain early. Carries the per-candidate trace.
 */
export class FailoverExhaustedError extends Error {
  constructor(public readonly tried: FailoverAttempt[]) {
    super(
      `Failover chain exhausted after ${tried.length} candidate(s): ` +
        tried.map((t) => `${t.connector}:${t.model}=${t.errorType}`).join(', '),
    );
    this.name = 'FailoverExhaustedError';
  }
}

/**
 * The whole-chain deadline ran out before every candidate was tried.
 * `lastHop` is the last provider error, when a hop had already failed.
 */
export class ChainDeadlineError extends Error {
  readonly type = 'chain_deadline_exceeded';

  constructor(
    public readonly tried: FailoverAttempt[],
    public readonly lastHop: {
      connector: string;
      model: string;
      errorType: string;
      message: string;
    } | null,
  ) {
    const tail = lastHop
      ? ` Last hop ${lastHop.connector}:${lastHop.model} failed with ${lastHop.errorType}: ${lastHop.message}`
      : ' No hop ran.';
    super(`Chain deadline exceeded.${tail}`);
    this.name = 'ChainDeadlineError';
  }
}

/**
 * Thrown when a candidate returns an ABORT-class error (validation_error, auth_error,
 * unsupported_modality, budget_exceeded, …) — failing over to another provider would not
 * help, so the chain stops immediately. Distinct from FailoverExhaustedError so the
 * caller can surface the original error's correct HTTP status (e.g. validation_error →
 * 400) instead of collapsing every abort to a generic 503 (QA D1 / PRD §7).
 *
 * A timeout after the client already received a chunk, and a timeout from a CLI
 * hop that may have executed tools, also stop here.
 */
export class FailoverAbortError extends Error {
  constructor(
    public readonly connector: string,
    public readonly model: string,
    public readonly errorType: string,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'FailoverAbortError';
  }
}

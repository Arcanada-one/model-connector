// CONN-0223 — Typed errors for cascade router exhaustion and budget enforcement.

export class CascadeExhaustedError extends Error {
  readonly type = 'cascade_exhausted';

  constructor(public readonly tried: { connector: string; model: string; errorType: string }[]) {
    super(`Cascade exhausted after ${tried.length} attempt(s)`);
    this.name = 'CascadeExhaustedError';
  }
}

export class CascadeBudgetExceededError extends Error {
  readonly type = 'budget_exceeded';

  constructor(
    public readonly dailyCostUsd: number,
    public readonly limitUsd: number,
  ) {
    super(`Cascade paid daily budget exceeded: $${dailyCostUsd.toFixed(4)} >= $${limitUsd}`);
    this.name = 'CascadeBudgetExceededError';
  }
}

// CONN-0102 — typed errors for the STT routing pipeline.
// Kept narrow: каждый класс несёт минимум полей, нужных для envelope-проекции
// в SpeechController. Конкретные http-mappings — в speech-response.dto.ts.

export type SttProviderErrorType =
  | 'auth_failed'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'timeout'
  | 'parse_error'
  | 'http_error'
  // CONN-0103: response shape mismatch — Zod schema rejection. Retryable
  // (cascade triggers next provider). NOT extends SttBudgetExhaustedError —
  // budget is a hard stop, drift is a soft one.
  | 'drift';

export class SttProviderError extends Error {
  readonly name = 'SttProviderError';
  constructor(
    readonly provider: string,
    readonly type: SttProviderErrorType,
    message: string,
    readonly upstreamCode?: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

export class SttAllProvidersExhausted extends Error {
  readonly name = 'SttAllProvidersExhausted';
  constructor(
    readonly providersTried: string[],
    readonly lastError?: SttProviderError,
  ) {
    super(`STT cascade exhausted; tried providers: ${providersTried.join(', ')}`);
  }
}

export class SttAudioTooLargeError extends Error {
  readonly name = 'SttAudioTooLargeError';
  constructor(
    readonly receivedBytes: number,
    readonly maxBytes: number,
  ) {
    super(`Audio payload ${receivedBytes} bytes exceeds limit ${maxBytes} bytes`);
  }
}

export class SttUnsupportedMimeError extends Error {
  readonly name = 'SttUnsupportedMimeError';
  constructor(
    readonly mimeType: string,
    readonly allowed: readonly string[],
  ) {
    super(`Unsupported audio MIME "${mimeType}"; allowed: ${allowed.join(', ')}`);
  }
}

/**
 * CONN-0103 — daily-cost hard cap fired.
 *
 * Standalone (NOT extends SttProviderError) intentionally: cascade-catch in
 * SttRouterService matches `instanceof SttProviderError` for retry; budget
 * exhaustion is terminal and must propagate up without triggering fallback
 * to the next provider. Maps to HTTP 503 in SpeechController.
 */
export class SttBudgetExhaustedError extends Error {
  readonly name = 'SttBudgetExhaustedError';
  constructor(
    readonly dailyCostUsd: number,
    readonly budgetUsd: number,
    // Always `[]` at the hard-CB gate (router throws before any provider call).
    // Field exists so the 503 envelope is shape-symmetric with
    // `stt_all_providers_exhausted` (clients can read `details.providers_tried`
    // unconditionally on both 503 codes).
    readonly providersTried: string[] = [],
  ) {
    super(`STT daily budget exhausted: $${dailyCostUsd.toFixed(4)} ≥ $${budgetUsd.toFixed(2)}`);
  }
}

/**
 * CONN-1671 — the caller's per-API-key access policy denied EVERY candidate STT
 * provider (the router dispatches directly, bypassing the ConnectorsService
 * choke point, so the gate is applied inline). Distinct from
 * `SttAllProvidersExhausted` (all providers were TRIED and failed) — here no
 * provider was ever attempted. Maps to HTTP 403 in SpeechController.
 *
 * The message names only provider identifiers (public) — NEVER env var names.
 */
export class SttPolicyViolationError extends Error {
  readonly name = 'SttPolicyViolationError';
  constructor(readonly providersDenied: string[]) {
    super(
      `STT request denied by this API key's access policy; ` +
        `all candidate providers were blocked: ${providersDenied.join(', ')}`,
    );
  }
}

/**
 * CONN-1671 — the stored `ApiKey.policy` failed schema validation on read
 * (`InvalidStoredPolicyError`). Fail-closed: the request is DENIED rather than
 * silently treated as unrestricted. Maps to HTTP 403 in SpeechController. The
 * message is intentionally generic (no policy internals, no env var names).
 */
export class SttPolicyConfigError extends Error {
  readonly name = 'SttPolicyConfigError';
  constructor() {
    super('Access policy for this API key could not be evaluated; request denied (fail-closed).');
  }
}

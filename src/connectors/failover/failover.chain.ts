// CONN-0243 — pure free-first failover chain.
//
// A behaviour-preserving sibling of the CascadeRouterService loop, but with NO
// instance state, NO paid-budget accumulator and NO metrics coupling (consilium
// R-F4: extracting a shared loop out of CascadeRouterService risked silently
// splitting its daily-budget accumulator, so the failover gateway owns a small,
// pure loop instead and reuses only the shared error-classification policy).
//
// NO fetch/http here — all transport is delegated through the injected `execute`.

import {
  ConnectorRequest,
  ConnectorResponse,
  classifyErrorAction,
} from '../interfaces/connector.interface';
import { CascadeCandidate } from '../cascade/cascade.profiles';
import { FailoverAttempt, FailoverExhaustedError, FailoverAbortError } from './failover.errors';

export type FailoverOutcome = 'success' | 'advance' | 'abort';

export interface RunFailoverChainArgs {
  candidates: CascadeCandidate[];
  /** Transport delegate — typically ConnectorsService.execute bound to an apiKeyId. */
  execute: (
    connector: string,
    request: ConnectorRequest,
    apiKeyId: string,
  ) => Promise<ConnectorResponse>;
  request: Omit<ConnectorRequest, 'connector'>;
  apiKeyId: string;
  /** Observability hook (metrics/logging) — pure chain stays side-effect free otherwise. */
  onAttempt?: (
    candidate: CascadeCandidate,
    response: ConnectorResponse | null,
    outcome: FailoverOutcome,
  ) => void;
}

/**
 * Try each candidate in order. Return the first successful ConnectorResponse.
 * On a retryable error (rate_limited / server_error / timeout / network_error /
 * circuit_open) advance to the next candidate; on an abort-class error stop and
 * throw. When every candidate is exhausted, throw FailoverExhaustedError.
 *
 * `circuit_open` is treated as advance (not abort): the breaker is per-connector,
 * so an open circuit on one provider is a signal to fail over, not to give up —
 * matching the cascade router's semantics.
 */
export async function runFailoverChain(args: RunFailoverChainArgs): Promise<ConnectorResponse> {
  const { candidates, execute, request, apiKeyId, onAttempt } = args;
  const tried: FailoverAttempt[] = [];

  for (const candidate of candidates) {
    const { connector, model } = candidate;
    const connectorRequest: ConnectorRequest = { ...request, model };

    let response: ConnectorResponse;
    try {
      response = await execute(connector, connectorRequest, apiKeyId);
    } catch (err) {
      // The transport delegate threw (e.g. NotFoundException for an unknown
      // connector). Treat as a soft failure and advance to the next candidate.
      const errorType = 'connector_unavailable';
      tried.push({ connector, model, errorType });
      onAttempt?.(candidate, null, 'advance');
      void err;
      continue;
    }

    if (response.status === 'success') {
      onAttempt?.(candidate, response, 'success');
      return response;
    }

    const errorType = response.error?.type ?? 'unknown';
    tried.push({ connector, model, errorType });

    // circuit_open is retryable in the failover context (per-connector breaker).
    const action = classifyErrorAction(errorType);
    const advanceable = action.retryable || errorType === 'circuit_open';

    if (!advanceable) {
      // Abort-class error (validation/auth/unsupported_modality/budget) — failing over
      // would not help. Stop and preserve the original error so the caller can map it to
      // the correct HTTP status (QA D1 / PRD §7), instead of a generic exhausted 503.
      onAttempt?.(candidate, response, 'abort');
      throw new FailoverAbortError(
        connector,
        model,
        errorType,
        response.error?.message ?? `Upstream ${errorType}`,
        response.error?.retryAfter,
      );
    }

    onAttempt?.(candidate, response, 'advance');
  }

  throw new FailoverExhaustedError(tried);
}

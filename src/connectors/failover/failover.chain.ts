// CONN-0243 — pure free-first failover chain.
//
// A behaviour-preserving sibling of the CascadeRouterService loop, but with NO
// instance state, NO paid-budget accumulator and NO metrics coupling (consilium
// R-F4: extracting a shared loop out of CascadeRouterService risked silently
// splitting its daily-budget accumulator, so the failover gateway owns a small,
// pure loop instead and reuses only the shared error-classification policy).
//
// NO fetch/http here — all transport is delegated through the injected `execute`.
//
// `timeout` is advanceable ONLY in this chain (and the cascade loop, which calls
// `chainShouldAdvance`). `classifyErrorAction('timeout')` stays
// `{ retryable: false, recommendation: 'abort' }` for direct callers.

import {
  ConnectorRequest,
  ConnectorResponse,
  classifyErrorAction,
} from '../interfaces/connector.interface';
import { CascadeCandidate } from '../cascade/cascade.profiles';
import {
  FailoverAttempt,
  FailoverExhaustedError,
  FailoverAbortError,
  ChainDeadlineError,
} from './failover.errors';
import { DEFAULT_CHAIN_DEADLINE_MS } from '../../config/chain-deadline';

export type FailoverOutcome = 'success' | 'advance' | 'abort';

/** A streaming transport calls `noteChunkSent` once the client has the first byte. */
export interface ChainHopSignals {
  noteChunkSent(): void;
}

export interface ChainHopFailure {
  connector: string;
  model: string;
  errorType: string;
  message: string;
}

export interface RunFailoverChainArgs {
  candidates: CascadeCandidate[];
  /** Transport delegate — typically ConnectorsService.execute bound to an apiKeyId. */
  execute: (
    connector: string,
    request: ConnectorRequest,
    apiKeyId: string,
    hop?: ChainHopSignals,
  ) => Promise<ConnectorResponse>;
  request: Omit<ConnectorRequest, 'connector'>;
  apiKeyId: string;
  /** Observability hook (metrics/logging) — pure chain stays side-effect free otherwise. */
  onAttempt?: (
    candidate: CascadeCandidate,
    response: ConnectorResponse | null,
    outcome: FailoverOutcome,
  ) => void;
  /** Whole-chain budget. Default {@link DEFAULT_CHAIN_DEADLINE_MS}. */
  deadlineMs?: number;
  /** Clock for the deadline. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * The hop's own per-attempt budget, before this chain caps it by the time
   * remaining. When omitted, the caller's `request.timeout` is that budget.
   */
  hopOwnTimeoutMs?: (candidate: CascadeCandidate) => number | undefined;
  /**
   * False when this hop may already have executed tools or written files (CLI).
   * A timeout then aborts instead of advancing. Default: advance.
   */
  allowTimeoutAdvance?: (candidate: CascadeCandidate) => boolean;
}

/**
 * True when a hop already delivered bytes to the client. Chain routes do not
 * stream today (`stream: true` is rejected on `/v1/chat/completions`, and
 * `POST /execute` has no stream field). A transport that does stream sets
 * `clientChunkSent` on the response it returns, or calls `noteChunkSent`.
 */
export function responseDeliveredChunk(response: ConnectorResponse): boolean {
  return (response as { clientChunkSent?: unknown }).clientChunkSent === true;
}

/**
 * Advance decision for failover and cascade. `classifyErrorAction` is not
 * modified: direct callers still see `timeout` as abort.
 *
 * Once a chunk has been sent, the chain does not advance. LiteLLM forwards an
 * SSE error instead of failing over once content has reached the client
 * (https://docs.litellm.ai/docs/proxy/error_reference).
 */
export function chainShouldAdvance(
  errorType: string,
  opts: { chunkSent: boolean; allowTimeoutAdvance: boolean },
): boolean {
  if (opts.chunkSent) return false;
  const action = classifyErrorAction(errorType);
  if (action.retryable || errorType === 'circuit_open') return true;
  return errorType === 'timeout' && opts.allowTimeoutAdvance;
}

/** `min(hop's own timeout, remaining chain budget)`, at least 1ms. */
export function capHopTimeout(ownTimeoutMs: number | undefined, remainingMs: number): number {
  const own = ownTimeoutMs === undefined ? remainingMs : ownTimeoutMs;
  return Math.max(1, Math.floor(Math.min(own, remainingMs)));
}

function failureOf(
  connector: string,
  model: string,
  errorType: string,
  message: string,
): ChainHopFailure {
  return { connector, model, errorType, message };
}

/**
 * Try each candidate in order. Return the first successful ConnectorResponse.
 * On a retryable error (rate_limited / server_error / network_error /
 * circuit_open) advance to the next candidate. A provider `timeout` also
 * advances, except when the client already has a chunk or the hop is not a
 * pure API generation. On an abort-class error stop and throw. When every
 * candidate is exhausted, throw FailoverExhaustedError. When the chain
 * deadline is spent with candidates left, throw ChainDeadlineError.
 *
 * `circuit_open` is treated as advance (not abort): the breaker is per-connector,
 * so an open circuit on one provider is a signal to fail over, not to give up —
 * matching the cascade router's semantics.
 */
export async function runFailoverChain(args: RunFailoverChainArgs): Promise<ConnectorResponse> {
  const {
    candidates,
    execute,
    request,
    apiKeyId,
    onAttempt,
    hopOwnTimeoutMs,
    allowTimeoutAdvance,
  } = args;
  const now = args.now ?? Date.now;
  const deadlineMs = args.deadlineMs ?? DEFAULT_CHAIN_DEADLINE_MS;
  const startedAt = now();
  const tried: FailoverAttempt[] = [];
  let lastHop: ChainHopFailure | null = null;

  for (const candidate of candidates) {
    const remaining = deadlineMs - (now() - startedAt);
    if (remaining < 1) {
      throw new ChainDeadlineError(tried, lastHop);
    }

    const { connector, model } = candidate;
    const connectorRequest: ConnectorRequest = {
      ...request,
      model,
      timeout: capHopTimeout(hopOwnTimeoutMs?.(candidate) ?? request.timeout, remaining),
    };
    let chunkSent = false;
    const hop: ChainHopSignals = {
      noteChunkSent() {
        chunkSent = true;
      },
    };

    let response: ConnectorResponse;
    try {
      response = await execute(connector, connectorRequest, apiKeyId, hop);
    } catch (err) {
      // The transport delegate threw (e.g. NotFoundException for an unknown
      // connector). Treat as a soft failure and advance to the next candidate.
      const errorType = 'connector_unavailable';
      const message = 'Connector unavailable';
      tried.push({ connector, model, errorType });
      lastHop = failureOf(connector, model, errorType, message);
      onAttempt?.(candidate, null, 'advance');
      void err;
      continue;
    }

    if (response.status === 'success') {
      onAttempt?.(candidate, response, 'success');
      return response;
    }

    const errorType =
      response.error?.type ?? (response.status === 'timeout' ? 'timeout' : 'unknown');
    const message = response.error?.message ?? `Upstream ${errorType}`;
    tried.push({ connector, model, errorType });
    lastHop = failureOf(connector, model, errorType, message);
    if (responseDeliveredChunk(response)) chunkSent = true;

    const advanceable = chainShouldAdvance(errorType, {
      chunkSent,
      allowTimeoutAdvance: allowTimeoutAdvance?.(candidate) ?? true,
    });

    if (!advanceable) {
      // Abort-class error (validation/auth/unsupported_modality/budget) — failing over
      // would not help. A timeout stops here too when a chunk was already sent or
      // the hop may have run tools. Preserve the original error so the caller can
      // map it to the correct HTTP status (QA D1 / PRD §7).
      onAttempt?.(candidate, response, 'abort');
      throw new FailoverAbortError(
        connector,
        model,
        errorType,
        message,
        response.error?.retryAfter,
      );
    }

    onAttempt?.(candidate, response, 'advance');
  }

  throw new FailoverExhaustedError(tried);
}

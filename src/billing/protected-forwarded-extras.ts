/**
 * Protected-profile audit of request.extra keys that admitted connectors
 * forward into the provider body.
 *
 * Every forwarded key must be one of:
 * - counted into the input UTF-8 upper bound;
 * - refused before dispatch when present (or when a required kill-switch is absent);
 * - shown not to add input tokens or non-token charges (sampling / stream flags).
 *
 * Perplexity (round 9 / Agent-Brain comment 6728472574): the class is refused
 * at the fence-admission table for the first protected Lab profile, so it has
 * no extras record and no protected `disable_search` path. Legacy unprotected
 * Perplexity traffic is unchanged.
 *
 * Round 10 / Agent-Brain comment 6728979426: non-Azure formerly-admitted
 * BaseApi classes are fence-refused for ungrounded chat-framing bounds, so
 * only AzureOpenAiConnector remains as an admitted forwardsMaxTokens:true
 * extras record.
 *
 * Round 7: fail closed when an admitted `forwardsMaxTokens: true` BaseApi class
 * has no extras record. Disposition keys must equal `forwardedExtraKeys` for
 * each record (single-source choice: keep two tables — fence admission keys and
 * this disposition table — bound by consistency tests; do not merge them, to
 * avoid a connectors↔billing import cycle).
 */

import { classForwardsProtectedMaxTokens } from '../connectors/protected-dispatch-fence-admission';

export type ProtectedExtraDisposition = 'neutral' | 'count_utf8' | 'refuse_when_present';

export interface ProtectedForwardedExtraRecord {
  className: string;
  /** Keys `buildRequestBody` may copy from `request.extra` (source-verified). */
  forwardedExtraKeys: readonly string[];
  disposition: Readonly<Record<string, ProtectedExtraDisposition>>;
  /**
   * When set, protected prepare requires this boolean extra to be strictly true
   * (Perplexity search kill-switch).
   */
  requireExtraTrue?: string;
}

/**
 * Exhaustive disposition table for admitted classes with `forwardsMaxTokens: true`.
 * Keep in sync with each connector's `buildRequestBody` and with
 * `PROTECTED_DISPATCH_FENCE_DECISIONS[].forwardedExtraKeys`.
 */
export const PROTECTED_FORWARDED_EXTRA_RECORDS: readonly ProtectedForwardedExtraRecord[] = [
  {
    className: 'AzureOpenAiConnector',
    forwardedExtraKeys: ['max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice'],
    disposition: {
      max_tokens: 'neutral', // output cap handled separately
      temperature: 'neutral',
      top_p: 'neutral',
      tools: 'count_utf8',
      tool_choice: 'count_utf8',
    },
  },
] as const;

const BY_CLASS: Map<string, ProtectedForwardedExtraRecord> = new Map(
  PROTECTED_FORWARDED_EXTRA_RECORDS.map((r) => [r.className, r]),
);

/**
 * Vitest-only: run `fn` while `className` has no extras record so the
 * admitted-forwarder-without-record refuse path can be exercised directly
 * (M-UNKNOWN-FWD). Restores the record afterward.
 */
export function __testOnlyWithoutExtrasRecord<T>(className: string, fn: () => T): T {
  if (process.env.VITEST !== 'true') {
    throw new Error('__testOnlyWithoutExtrasRecord is test-only (VITEST!==true).');
  }
  const saved = BY_CLASS.get(className);
  if (!saved) {
    throw new Error(`__testOnlyWithoutExtrasRecord: no record for ${className}`);
  }
  BY_CLASS.delete(className);
  try {
    return fn();
  } finally {
    BY_CLASS.set(className, saved);
  }
}

function utf8JsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    // Unserializable payloads cannot be bounded — caller must refuse.
    return -1;
  }
}

export type ProtectedForwardedExtrasResult =
  | { ok: true; countedInputBytes: number }
  | { ok: false; message: string; countedInputBytes: 0 };

/**
 * Assess forwarded extras for a protected prepare.
 *
 * - Admitted BaseApi class with `forwardsMaxTokens: true` and no extras record → refuse.
 * - Unknown / non-forwarding class (including non-Base doubles with null className) → no-op ok.
 */
export function assessProtectedForwardedExtras(params: {
  connectorClassName: string | null | undefined;
  extra?: Record<string, unknown> | null;
}): ProtectedForwardedExtrasResult {
  const record = params.connectorClassName ? BY_CLASS.get(params.connectorClassName) : undefined;
  if (!record) {
    if (params.connectorClassName && classForwardsProtectedMaxTokens(params.connectorClassName)) {
      return {
        ok: false,
        countedInputBytes: 0,
        message: `Protected prepare refuses admitted forwarder ${params.connectorClassName} without a reviewed extras record.`,
      };
    }
    return { ok: true, countedInputBytes: 0 };
  }

  const extra = params.extra ?? {};

  if (record.requireExtraTrue) {
    const flag = extra[record.requireExtraTrue];
    if (flag !== true) {
      return {
        ok: false,
        countedInputBytes: 0,
        message: `Protected prepare for ${record.className} requires ${record.requireExtraTrue}=true so unpriced non-token fees cannot apply.`,
      };
    }
  }

  let countedInputBytes = 0;
  for (const key of record.forwardedExtraKeys) {
    if (!Object.prototype.hasOwnProperty.call(extra, key)) continue;
    const value = extra[key];
    if (value === undefined) continue;
    const disposition = record.disposition[key];
    if (disposition == null) {
      return {
        ok: false,
        countedInputBytes: 0,
        message: `Protected prepare refuses unreviewed forwarded extra '${key}' for ${record.className}.`,
      };
    }
    if (disposition === 'refuse_when_present') {
      return {
        ok: false,
        countedInputBytes: 0,
        message: `Protected prepare refuses forwarded extra '${key}' for ${record.className} (unpriced input or non-token fee).`,
      };
    }
    if (disposition === 'count_utf8') {
      const bytes = utf8JsonBytes(value);
      if (bytes < 0) {
        return {
          ok: false,
          countedInputBytes: 0,
          message: `Protected prepare cannot UTF-8-bound forwarded extra '${key}' for ${record.className}.`,
        };
      }
      countedInputBytes += bytes;
    }
  }

  return { ok: true, countedInputBytes };
}

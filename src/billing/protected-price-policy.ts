/**
 * Server-side protected Lab price-policy provenance.
 *
 * A client-supplied revision string is never authority. The revision and hold
 * are derived from the catalogue row for the exact connector/model (and the
 * protected route key), or the prepare is refused with NATIVE_PRICING_UNAVAILABLE.
 */

import { createHash } from 'crypto';

import {
  ceilUsdToLedgerPrecision,
  estimateProtectedHoldUsd,
  protectedOutputTokenCap,
} from './protected-cost-estimate';

export const NATIVE_PRICING_UNAVAILABLE = 'NATIVE_PRICING_UNAVAILABLE' as const;
export const PROTECTED_PRICE_REVISION_MISMATCH = 'protected_price_revision_mismatch' as const;

/**
 * Maximum age of an authoritative catalogue price observation for the
 * protected profile. Full refresh defaults to every 15m; 60m is four cycles
 * of headroom before fail-closed refusal.
 */
export const PROTECTED_PRICE_MAX_AGE_MS = 60 * 60 * 1000;

/** Allow tiny clock skew so a just-written row is not refused as "future". */
const PROTECTED_PRICE_FUTURE_SKEW_MS = 60_000;

export interface ProtectedCatalogAuthorityRow {
  connector: string;
  model: string;
  tier: string;
  free?: boolean;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  contentFingerprint?: string | null;
  snapshotId?: string | null;
  /** Row observation time; required for protected freshness. */
  observedAt?: Date | string | null;
  /** Catalog freshness enum: fresh | stale | static | unknown. */
  freshness?: string | null;
  /**
   * True only when the row's snapshot came from the authoritative refresh
   * path (`CatalogSnapshot.authoritative`). Absent/unknown → refuse.
   */
  authoritative?: boolean | null;
}

export type ProtectedPricePolicyResult =
  | {
      outcome: 'resolved';
      pricePolicyRevision: string;
      holdUsd: string;
      positivelyZero: boolean;
      /** Hard bound used for the hold (forwarded max_tokens, or 0 when zero-priced). */
      assumedOutputTokens: number;
    }
  | {
      outcome: 'unavailable';
      code: typeof NATIVE_PRICING_UNAVAILABLE;
      message: string;
    }
  | {
      outcome: 'mismatch';
      code: typeof PROTECTED_PRICE_REVISION_MISMATCH;
      message: string;
      serverRevision: string;
    };

function pinFingerprint(parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * True only when the catalogue positively prices this model at zero — free tier
 * or explicit zero tariffs. Null tariffs on a non-free row are unknown, not free.
 */
export function isPositivelyZeroPriced(row: ProtectedCatalogAuthorityRow): boolean {
  const freeTier = row.tier === 'free' || row.free === true;
  const bothZero = row.inputPerMTok === 0 && row.outputPerMTok === 0;
  const bothNull = row.inputPerMTok == null && row.outputPerMTok == null;
  if (bothZero) return true;
  if (freeTier && bothNull) return true;
  if (freeTier && bothZero) return true;
  return false;
}

/**
 * Provenance gate: authoritative refresh path + known age within max age.
 * Fail closed when any field is missing or unverifiable.
 */
export function isAuthoritativeFreshPricing(
  row: ProtectedCatalogAuthorityRow,
  now: Date = new Date(),
  maxAgeMs: number = PROTECTED_PRICE_MAX_AGE_MS,
): boolean {
  if (row.authoritative !== true) return false;
  if (row.freshness !== 'fresh') return false;
  const observed = asDate(row.observedAt ?? null);
  if (!observed) return false;
  const ageMs = now.getTime() - observed.getTime();
  if (ageMs < -PROTECTED_PRICE_FUTURE_SKEW_MS) return false;
  if (ageMs > maxAgeMs) return false;
  return true;
}

export function isTrustedPricedRow(row: ProtectedCatalogAuthorityRow): boolean {
  if (row.tier === 'unknown') return false;
  if (isPositivelyZeroPriced(row)) return true;
  // Paid / known tariffs: BOTH sides must be finite numbers. A partial-null row
  // would be under-held (null side counted as 0 by estimateCostUsd) and is not
  // a trusted hard bound. Both-null on a non-free tier is unknown, not free.
  if (row.inputPerMTok == null || row.outputPerMTok == null) return false;
  if (!Number.isFinite(row.inputPerMTok) || !Number.isFinite(row.outputPerMTok)) {
    return false;
  }
  // Negative rates are never a legitimate provider tariff for a hard hold.
  if (row.inputPerMTok < 0 || row.outputPerMTok < 0) return false;
  return true;
}

export function deriveProtectedPricePolicyRevision(
  row: ProtectedCatalogAuthorityRow,
  routeKey: string,
): string {
  // Every pin binds connector + model + route key. A contentFingerprint alone
  // is not route-scoped — hash it together with the binding material.
  const contentFp =
    typeof row.contentFingerprint === 'string' && /^[a-f0-9]{32,64}$/i.test(row.contentFingerprint)
      ? row.contentFingerprint.toLowerCase()
      : null;
  const fp = contentFp
    ? pinFingerprint([row.connector, row.model, routeKey, contentFp])
    : pinFingerprint([
        row.connector,
        row.model,
        routeKey,
        row.tier,
        row.snapshotId ?? '',
        String(row.inputPerMTok),
        String(row.outputPerMTok),
      ]);
  return isPositivelyZeroPriced(row) ? `zero:catalog:${fp}` : `catalog:${fp}`;
}

/**
 * Derive the trusted revision + hold for a protected prepare.
 *
 * `catalogReadable=false` covers catalogue read failures. A missing row, unknown
 * tier, or unpriced model refuses. When `clientRevision` is provided it must
 * equal the server revision; otherwise the client value is ignored.
 */
export function resolveProtectedPricePolicy(params: {
  catalogReadable: boolean;
  row: ProtectedCatalogAuthorityRow | null;
  routeKey: string;
  /** Upper-bound input token count for the final effective request. */
  inputTokenUpperBound: number;
  maxTokens?: unknown;
  /** True only when the admitted connector class forwards `max_tokens`. */
  connectorForwardsMaxTokens: boolean;
  clientRevision?: string | null;
  now?: Date;
}): ProtectedPricePolicyResult {
  if (!params.catalogReadable) {
    return {
      outcome: 'unavailable',
      code: NATIVE_PRICING_UNAVAILABLE,
      message: 'Protected prepare cannot read the pricing catalogue.',
    };
  }
  if (!params.row) {
    return {
      outcome: 'unavailable',
      code: NATIVE_PRICING_UNAVAILABLE,
      message: 'Protected prepare has no catalogue price for this connector/model.',
    };
  }
  if (!isAuthoritativeFreshPricing(params.row, params.now ?? new Date())) {
    return {
      outcome: 'unavailable',
      code: NATIVE_PRICING_UNAVAILABLE,
      message:
        'Protected prepare refuses catalogue tariffs without authoritative fresh provenance.',
    };
  }
  if (!isTrustedPricedRow(params.row)) {
    return {
      outcome: 'unavailable',
      code: NATIVE_PRICING_UNAVAILABLE,
      message: 'Protected prepare refuses unknown or unpriced catalogue tariffs.',
    };
  }

  const positivelyZero = isPositivelyZeroPriced(params.row);
  const revision = deriveProtectedPricePolicyRevision(params.row, params.routeKey);

  let holdUsd: string;
  let outputTokens: number;

  if (positivelyZero) {
    holdUsd = ceilUsdToLedgerPrecision(0);
    outputTokens = 0;
  } else {
    const capped = protectedOutputTokenCap({
      maxTokens: params.maxTokens,
      connectorForwardsMaxTokens: params.connectorForwardsMaxTokens,
    });
    if (capped == null) {
      return {
        outcome: 'unavailable',
        code: NATIVE_PRICING_UNAVAILABLE,
        message:
          'Protected prepare requires an explicit max_tokens that the admitted connector forwards.',
      };
    }
    outputTokens = capped;
    const rawHold = estimateProtectedHoldUsd({
      inputTokenUpperBound: params.inputTokenUpperBound,
      outputTokenCap: outputTokens,
      inputPerMTok: params.row.inputPerMTok as number,
      outputPerMTok: params.row.outputPerMTok as number,
    });
    holdUsd = ceilUsdToLedgerPrecision(rawHold);
    const hold = Number(holdUsd);
    // Bound: the hold must be the catalogue-priced estimate. An unknown-model
    // floor must never admit a protected reservation.
    if (!(hold > 0) || !Number.isFinite(hold)) {
      return {
        outcome: 'unavailable',
        code: NATIVE_PRICING_UNAVAILABLE,
        message: 'Protected prepare could not derive a positive hard cost bound.',
      };
    }
  }

  const client = params.clientRevision?.trim() || '';
  if (client && client !== revision) {
    return {
      outcome: 'mismatch',
      code: PROTECTED_PRICE_REVISION_MISMATCH,
      message: 'Client pricePolicyRevision does not match the server-derived catalogue pin.',
      serverRevision: revision,
    };
  }

  return {
    outcome: 'resolved',
    pricePolicyRevision: revision,
    holdUsd,
    positivelyZero,
    assumedOutputTokens: outputTokens,
  };
}

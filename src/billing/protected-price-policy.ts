/**
 * Server-side protected Lab price-policy provenance.
 *
 * A client-supplied revision string is never authority. The revision and hold
 * are derived from the catalogue row for the exact connector/model (and the
 * protected route key), or the prepare is refused with NATIVE_PRICING_UNAVAILABLE.
 */

import { createHash } from 'crypto';

import { assumedOutputTokens, estimateCostUsd } from './cost-estimate';

export const NATIVE_PRICING_UNAVAILABLE = 'NATIVE_PRICING_UNAVAILABLE' as const;
export const PROTECTED_PRICE_REVISION_MISMATCH = 'protected_price_revision_mismatch' as const;

export interface ProtectedCatalogAuthorityRow {
  connector: string;
  model: string;
  tier: string;
  free?: boolean;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  contentFingerprint?: string | null;
  snapshotId?: string | null;
}

export type ProtectedPricePolicyResult =
  | {
      outcome: 'resolved';
      pricePolicyRevision: string;
      holdUsd: string;
      positivelyZero: boolean;
      /** Hard bound used for the hold (assumed output tokens under the budget policy). */
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
  promptLength: number;
  maxTokens?: unknown;
  clientRevision?: string | null;
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
  if (!isTrustedPricedRow(params.row)) {
    return {
      outcome: 'unavailable',
      code: NATIVE_PRICING_UNAVAILABLE,
      message: 'Protected prepare refuses unknown or unpriced catalogue tariffs.',
    };
  }

  const positivelyZero = isPositivelyZeroPriced(params.row);
  const revision = deriveProtectedPricePolicyRevision(params.row, params.routeKey);
  const outputTokens = assumedOutputTokens(params.maxTokens);

  let hold: number;
  if (positivelyZero) {
    hold = 0;
  } else {
    hold = estimateCostUsd(
      params.promptLength,
      {
        inputPerMTok: params.row.inputPerMTok,
        outputPerMTok: params.row.outputPerMTok,
      },
      { maxTokens: params.maxTokens },
    );
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
    holdUsd: hold.toFixed(6),
    positivelyZero,
    assumedOutputTokens: outputTokens,
  };
}

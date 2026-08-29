/**
 * ARAS-0058 — turn measured tokens into measured money.
 *
 * The sibling of `cost-estimate.ts`. The estimate answers "can this account
 * afford the call?" BEFORE dispatch and is never charged; this module answers
 * "what did the call actually cost?" AFTER dispatch, and its answer IS what
 * gets charged.
 *
 * The bug this exists to close: nearly every connector captured
 * `prompt_tokens`/`completion_tokens` from the provider and then returned
 * `costUsd: 0`, so every `charge` row ever written to `credits_ledger` was
 * $0.000000. Enforcement was live and correct, but a funded balance could never
 * be drawn down because no reachable path converted usage into money.
 *
 * Two connectors already did the right thing — claude-code reads
 * `total_cost_usd`, openrouter reads `usage.total_cost` — and a provider-reported
 * number always wins here: it is the provider's own invoice, and a catalogue
 * price is at best our copy of a published tariff.
 *
 * ## On trusting the catalogue
 *
 * The catalogue (`model_catalog`, per-1M-token tariffs, refreshed from each
 * provider's own `/models` listing) is the ONLY pricing source; building a
 * second one would guarantee they disagree. It is also known to drift from
 * provider reality (CONN-0238, SEC-0067). This module therefore does not
 * pretend the row is right — it records WHERE each number came from
 * (`CostSource`) so a reconciliation can find every charge that rests on a
 * catalogue row rather than on a provider invoice, and every request served at
 * a price we never knew.
 */

/** Where a settled cost came from. Persisted on `Request.costSource`. */
export type CostSource =
  /** The provider itself reported a cost. Authoritative; never overwritten. */
  | 'provider'
  /** Computed from catalogue tariffs × measured tokens. */
  | 'catalog'
  /** Catalogued as a free-tier model with no numeric tariff: $0 is the price. */
  | 'catalog-free'
  /** Nothing was consumed (error, refusal, or a connector reporting no usage). */
  | 'zero-usage'
  /** Tokens were consumed and NO price was known. See the note below. */
  | 'unpriced';

/** The pricing fields of a `model_catalog` row. */
export interface MeasuredCostPricing {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  /** `deriveTier` output: 'free' | 'paid' | 'unknown'. */
  tier?: string | null;
}

export interface MeasuredCost {
  costUsd: number;
  source: CostSource;
}

/** Catalogue tariffs are USD per 1M tokens (`priceUnit` = 'USD/1M tokens'). */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * `Request.costUsd` is `Decimal(10,6)` and `CreditsLedger.amountUsd` is
 * `Decimal(12,6)`, so the database rounds to six places whatever we hand it.
 * Rounding here as well keeps the number in the API response, the request row
 * and the ledger row identical instead of differing in the last place.
 */
const COST_DECIMALS = 6;

function roundToStorage(usd: number): number {
  const scale = 10 ** COST_DECIMALS;
  return Math.round(usd * scale) / scale;
}

function isUsablePrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonNegativeTokens(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Price one completed request.
 *
 * ## What happens when the price is unknown (the decision, and why)
 *
 * A missing catalogue row resolves to `costUsd: 0` with source `'unpriced'` —
 * an explicit marker, NOT a silent zero. The distinction is the whole point:
 * a silent zero is indistinguishable from a free model and is exactly the bug
 * this module exists to close.
 *
 * Failing CLOSED — refusing the request — is the better answer, and it is
 * already implemented, but it belongs one step earlier: `openRequestIntent()`
 * prices an uncatalogued model at `UNKNOWN_MODEL_ESTIMATE_USD` before dispatch
 * and RESERVES that estimate against the balance, so an unpriced model already
 * cannot be called on an empty balance. By the time this
 * function runs the provider has been called and has been paid; there is
 * nothing left to refuse. The only remaining choices are to charge a number we
 * invented — which `BillingService` forbids on purpose ("a caller must never be
 * billed for a number we made up") — or to record honestly that we served a
 * request we could not price. This does the latter, and makes it queryable:
 *
 *     SELECT connector, model, count(*), sum("totalTokens")
 *       FROM "Request" WHERE "costSource" = 'unpriced' GROUP BY 1, 2;
 *
 * is the list of models whose catalogue rows need fixing, and the size of the
 * revenue leak while they are not.
 *
 * Note the deliberate asymmetry with `'catalog-free'`: a catalogue row that
 * says a model is free-tier IS a price — zero — and is charged as such. Only
 * the absence of any price at all is `'unpriced'`.
 */
export function measureCostUsd(input: {
  /** Cost as reported by the provider, if it reports one at all. */
  providerCostUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** The catalogue row for the model actually served, or null if there is none. */
  pricing?: MeasuredCostPricing | null;
}): MeasuredCost {
  const { providerCostUsd, pricing } = input;

  // 1. A provider invoice beats any tariff we hold a copy of.
  if (
    typeof providerCostUsd === 'number' &&
    Number.isFinite(providerCostUsd) &&
    providerCostUsd > 0
  ) {
    return { costUsd: roundToStorage(providerCostUsd), source: 'provider' };
  }

  const inputTokens = nonNegativeTokens(input.inputTokens);
  const outputTokens = nonNegativeTokens(input.outputTokens);

  // 2. Nothing was consumed, so nothing is owed — and that is true at every
  //    tariff, including one we do not know. Errors and refusals land here, and
  //    keeping them out of 'unpriced' is what keeps that marker meaningful.
  if (inputTokens === 0 && outputTokens === 0) {
    return { costUsd: 0, source: 'zero-usage' };
  }

  // 3. A real tariff. One side may be missing (some providers publish only a
  //    prompt price); the missing side contributes nothing rather than voiding
  //    the whole calculation, which would throw away a cost we do know.
  const inputPerMTok = isUsablePrice(pricing?.inputPerMTok) ? pricing.inputPerMTok : null;
  const outputPerMTok = isUsablePrice(pricing?.outputPerMTok) ? pricing.outputPerMTok : null;
  if (inputPerMTok !== null || outputPerMTok !== null) {
    const cost =
      (inputTokens * (inputPerMTok ?? 0) + outputTokens * (outputPerMTok ?? 0)) /
      TOKENS_PER_PRICE_UNIT;
    return { costUsd: roundToStorage(cost), source: 'catalog' };
  }

  // 4. Catalogued free-tier with no numeric tariff — e.g. every groq chat model,
  //    whose list price CONN-1672 suppresses precisely because the free tier is
  //    genuinely $0. That is a known price, not a missing one.
  if (pricing && pricing.tier === 'free') {
    return { costUsd: 0, source: 'catalog-free' };
  }

  // 5. Tokens were burned at a price nobody knows. Marked, never silently zero.
  return { costUsd: 0, source: 'unpriced' };
}

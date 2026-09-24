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
  /**
   * A2-295 — tokens were consumed by an attempt that was ABORTED before the
   * provider answered, so the token counts are OURS (estimated from the prompt
   * we sent) and not the provider's.
   *
   * It exists because the alternative on this path was `'zero-usage'` — "nothing
   * was consumed" — asserted about a request whose entire prompt the provider
   * had already read and will bill for. Measured on the A2-278 receipt: a run
   * the provider charged $0.086584 for was recorded by Model Connector as
   * $0.000000, so no `max_cost_usd` anywhere in the stack could see it.
   *
   * Kept separate from `'catalog'` rather than folded into it because the
   * tariff is the catalogue's and trustworthy while the TOKEN COUNT is an
   * estimate, and a reconciliation must be able to find every charge that rests
   * on one:
   *
   *     SELECT sum("costUsd") FROM "Request" WHERE "costSource" = 'estimated-input';
   *
   * is the amount of the ledger nobody metered. It is an under-statement by
   * construction — output tokens the provider may have generated before we hung
   * up are charged at zero, because we cannot count them and guessing upward
   * would bill a caller for output they never received.
   */
  | 'estimated-input'
  /** Tokens were consumed and NO price was known. See the note below. */
  | 'unpriced'
  /**
   * A2-223 — the call ran on a SUBSCRIPTION lane (a locally authenticated CLI
   * covered by a seat/plan: claude-code, codex, cursor, gemini), so no cash
   * changed hands per token and none of the sources above can describe it.
   *
   * The number such a lane reports is NOTIONAL: `claude -p --output-format
   * json` returns `total_cost_usd`, the API list price of the same tokens, for
   * a session that a flat-rate plan has already paid for. Recording that as
   * `'provider'` said "the provider invoiced us this" about money nobody was
   * invoiced for — and $120.15 of such charges were measured on one host in ten
   * days (2026-09-13..2026-09-23, 307 rows, every one of them written off as
   * `uncollectible` once the key's balance ran out).
   *
   * `costUsd` deliberately keeps the notional figure so no balance moves on the
   * strength of this change alone; {@link MeasuredCost.notionalCostUsd} names it
   * for what it is and this source makes it filterable:
   *
   *     SELECT sum("costUsd") FROM "Request" WHERE "costSource" = 'subscription';
   *
   * is the amount of a ledger that is not cash. Whether such a lane should debit
   * a cash balance at all is a billing-policy decision, recorded as a follow-up
   * rather than taken here by a change whose job was to make it visible.
   */
  | 'subscription';

/**
 * A2-223 — how a connector is paid for, declared by the connector itself.
 *
 * `'api'` — metered per token against an account we are invoiced for; the
 * catalogue tariff is real money. `'subscription'` — a seat/plan already paid
 * for, where per-token arithmetic produces a notional figure and not a bill.
 *
 * This is a property of the LANE, not of the model: `claude-sonnet-5` is
 * `'api'` through the anthropic connector and `'subscription'` through the
 * claude-code CLI, and the same tokens are worth cash on one and nothing on the
 * other.
 */
export type BillingLane = 'api' | 'subscription';

/** The pricing fields of a `model_catalog` row. */
export interface MeasuredCostPricing {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  /**
   * Price of an input token served FROM the provider's cache, when the
   * catalogue carries one (CONN-0272). Typically a fraction of `inputPerMTok` —
   * that discount is the entire economic point of prompt caching, and billing
   * cached tokens at the full input rate overstates the cost of every cached
   * request.
   *
   * Null means the catalogue has no cache tariff, NOT that caching is free:
   * cached tokens then fall back to `inputPerMTok`, which is the conservative
   * direction (we never under-bill on an assumption).
   */
  cachedInputPerMTok?: number | null;
  /** `deriveTier` output: 'free' | 'paid' | 'unknown'. */
  tier?: string | null;
}

export interface MeasuredCost {
  costUsd: number;
  source: CostSource;
  /**
   * The `costUsd` total, split by what was billed for (CONN-0272).
   *
   * Both halves are already computed to produce the total; keeping them is what
   * makes "which half is the bill" answerable. Null — not zero — when the split
   * is genuinely unknown: a provider invoice arrives as one number, and
   * inventing a split for it would fabricate evidence exactly as a back-filled
   * `costSource` would. Zero means "measured, and it was zero".
   */
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  /**
   * A2-223 — a figure that is NOT cash: what a subscription lane's tokens would
   * have cost at API list price. Present only for `source: 'subscription'`, and
   * null there when the lane reported no figure at all.
   *
   * Kept separate from `costUsd` on purpose. A reader that sums `costUsd` gets
   * today's number (nothing about any balance changes with this field landing);
   * a reader that wants cash subtracts the rows this field is set on.
   */
  notionalCostUsd?: number | null;
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
  /**
   * Input tokens served from the provider's cache (CONN-0272).
   *
   * MUST be a SUBSET of `inputTokens`, matching how providers report it: the
   * cached count is part of the input total, not an addition to it. Passing a
   * value larger than `inputTokens` would compute a negative uncached
   * remainder, so it is clamped rather than trusted.
   */
  cachedInputTokens?: number | null;
  /** The catalogue row for the model actually served, or null if there is none. */
  pricing?: MeasuredCostPricing | null;
  /**
   * A2-223 — how this connector is paid for (see {@link BillingLane}).
   *
   * Optional and defaulting to `'api'`, which is what every caller before this
   * field existed meant: an omitted lane produces byte-identical output to the
   * previous implementation.
   */
  lane?: BillingLane;
  /**
   * A2-295 — true when `inputTokens` was ESTIMATED from the prompt rather than
   * reported by the provider (an aborted attempt). Only changes the `source`
   * the result carries; the arithmetic is identical, because the tariff is the
   * same tariff and only the token count is ours.
   */
  estimatedUsage?: boolean;
}): MeasuredCost {
  const { providerCostUsd, pricing } = input;

  const providerReported =
    typeof providerCostUsd === 'number' && Number.isFinite(providerCostUsd) && providerCostUsd > 0
      ? providerCostUsd
      : null;
  const inputTokens = nonNegativeTokens(input.inputTokens);
  const outputTokens = nonNegativeTokens(input.outputTokens);
  const nothingConsumed = providerReported === null && inputTokens === 0 && outputTokens === 0;

  // 1. Nothing was consumed, so nothing is owed — and that is true at every
  //    tariff, including one we do not know, and on every lane. Errors and
  //    refusals land here, and keeping them out of 'unpriced' is what keeps
  //    that marker meaningful.
  //
  //    A2-223 moved this ahead of the provider branch below. That is not a
  //    behaviour change: the branch only fires when the provider reported no
  //    figure, which is exactly when the provider branch would not have fired
  //    either. It is ahead of the subscription branch so that a CLI that failed
  //    without consuming anything still reads 'zero-usage' rather than being
  //    relabelled by its lane.
  if (nothingConsumed) {
    return { costUsd: 0, source: 'zero-usage', inputCostUsd: 0, outputCostUsd: 0 };
  }

  // 2. A2-223 — a subscription lane. The seat is already paid for, so there is
  //    no per-token cash cost to compute and no catalogue tariff that would
  //    mean anything if there were: the figure the CLI reports is the API list
  //    price of tokens nobody was invoiced for.
  //
  //    `costUsd` keeps that figure — this change makes the money legible, it
  //    does not move anybody's balance — and `notionalCostUsd` says out loud
  //    what kind of number it is. `null` there means the lane reported nothing,
  //    which is not the same as reporting zero.
  if (input.lane === 'subscription') {
    return {
      costUsd: providerReported === null ? 0 : roundToStorage(providerReported),
      source: 'subscription',
      inputCostUsd: null,
      outputCostUsd: null,
      notionalCostUsd: providerReported === null ? null : roundToStorage(providerReported),
    };
  }

  // 3. A provider invoice beats any tariff we hold a copy of.
  if (providerReported !== null) {
    // The invoice is one number. `null` halves say so rather than guessing.
    return {
      costUsd: roundToStorage(providerReported),
      source: 'provider',
      inputCostUsd: null,
      outputCostUsd: null,
    };
  }

  // 4. A real tariff. One side may be missing (some providers publish only a
  //    prompt price); the missing side contributes nothing rather than voiding
  //    the whole calculation, which would throw away a cost we do know.
  const inputPerMTok = isUsablePrice(pricing?.inputPerMTok) ? pricing.inputPerMTok : null;
  const outputPerMTok = isUsablePrice(pricing?.outputPerMTok) ? pricing.outputPerMTok : null;
  if (inputPerMTok !== null || outputPerMTok !== null) {
    // Cached input is a SUBSET of input, so the uncached remainder is what is
    // left after removing it. Clamped: a provider reporting more cached tokens
    // than input tokens is a bug on their side, and a negative remainder here
    // would silently credit the customer.
    const cachedInputTokens = Math.min(nonNegativeTokens(input.cachedInputTokens), inputTokens);
    const uncachedInputTokens = inputTokens - cachedInputTokens;
    // No cache tariff → cached tokens bill at the normal input rate. That is
    // the conservative direction: it can overstate the cost of a cache hit, and
    // never understates it.
    const cachedRate = isUsablePrice(pricing?.cachedInputPerMTok)
      ? pricing.cachedInputPerMTok
      : inputPerMTok;
    const inputCost =
      (uncachedInputTokens * (inputPerMTok ?? 0) + cachedInputTokens * (cachedRate ?? 0)) /
      TOKENS_PER_PRICE_UNIT;
    const outputCost = (outputTokens * (outputPerMTok ?? 0)) / TOKENS_PER_PRICE_UNIT;
    // The TOTAL is computed from the unrounded halves, so the charge never
    // inherits a rounding error from the split.
    //
    // The two halves are each rounded to the six decimals their column stores,
    // which means they can sum to 1e-6 LESS (or more) than `costUsd` when the
    // total rounds one way and both halves round the other. Observed in prod:
    // 0.00013132 -> 0.000131 and 0.0000714 -> 0.000071 (both down) against a
    // total 0.00020272 -> 0.000203 (up).
    //
    // That is accepted, not a defect to paper over. Forcing the halves to add
    // up would require storing a half that is not the correctly-rounded price
    // of its own tokens — falsifying a measurement to satisfy an arithmetic
    // identity. Reconciliation queries must therefore allow a 1e-6 tolerance.
    return {
      costUsd: roundToStorage(inputCost + outputCost),
      // A2-295 — the tariff came from the catalogue either way; the source says
      // whether the TOKENS did. An estimated count charged as `'catalog'` would
      // be indistinguishable from a metered one in every reconciliation query.
      source: input.estimatedUsage ? 'estimated-input' : 'catalog',
      inputCostUsd: roundToStorage(inputCost),
      outputCostUsd: roundToStorage(outputCost),
    };
  }

  // 5. Catalogued free-tier with no numeric tariff — e.g. every groq chat model,
  //    whose list price CONN-1672 suppresses precisely because the free tier is
  //    genuinely $0. That is a known price, not a missing one.
  if (pricing && pricing.tier === 'free') {
    return { costUsd: 0, source: 'catalog-free', inputCostUsd: 0, outputCostUsd: 0 };
  }

  // 6. Tokens were burned at a price nobody knows. Marked, never silently zero.
  // Never computed, so there is no split to report. Null, not zero — the same
  // distinction `costSource: 'unpriced'` exists to preserve.
  return { costUsd: 0, source: 'unpriced', inputCostUsd: null, outputCostUsd: null };
}

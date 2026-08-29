/**
 * ARAS-0064 — conservative pre-call cost estimate.
 *
 * A precheck has to answer "can this account afford the call?" BEFORE the call
 * happens, which means before the output length is known. So the estimate is
 * deliberately pessimistic: it assumes a full-length response. Overestimating
 * refuses a few requests an account could just barely have afforded;
 * underestimating lets an account go negative, which is the failure that costs
 * real money.
 *
 * The estimate is NEVER charged. Settlement always uses the measured
 * `Request.costUsd` — a caller must not be billed for a number we invented.
 *
 * ARAS-0058 closed the hole that made "pessimistic" untrue in the one case it
 * mattered. The assumed output length was a hardcoded 2 000 tokens and
 * caller-supplied `max_tokens` was ignored entirely, so a caller asking for
 * 64 000 output tokens on an expensive model was under-estimated by ~32x — by a
 * parameter the CALLER chooses, which makes it a spend-control bypass rather
 * than an inaccuracy. The estimate now takes the larger of the two.
 */

import type { ContentBlock } from '../connectors/interfaces/connector.interface';

/** Rough chars-per-token. Only ever used to size an estimate, never a charge. */
const CHARS_PER_TOKEN = 4;

/**
 * Output tokens assumed when the caller names no ceiling of their own.
 *
 * Also a FLOOR under a caller-supplied `max_tokens`, never merely a default.
 * Not every connector forwards `max_tokens` to its provider — the CLI
 * connectors drop it — so a small caller-supplied value is a request, not a
 * guarantee, and letting it lower the estimate would hand the caller a way to
 * under-reserve. Raising the estimate on a large `max_tokens` is safe for the
 * opposite reason: the provider will honour the ceiling, so the cost really can
 * reach it.
 */
const ASSUMED_OUTPUT_TOKENS = 2_000;

/**
 * Floor applied when the model is absent from the catalogue.
 *
 * Zero would be wrong: an unpriced model would then be free to call on an empty
 * balance, and "unknown price" is exactly when the caller is least protected.
 * A small positive floor means a depleted account is still refused, which is
 * the property the DoD asks for.
 */
export const UNKNOWN_MODEL_ESTIMATE_USD = 0.01;

export interface CatalogPricing {
  inputPerMTok?: number | null;
  outputPerMTok?: number | null;
}

export interface EstimateOptions {
  /**
   * The caller's `max_tokens`, as passed through on `request.extra`. Only ever
   * raises the assumed output length, never lowers it — see
   * {@link ASSUMED_OUTPUT_TOKENS}.
   */
  maxTokens?: unknown;
}

/**
 * How many output tokens to price.
 *
 * Rejects anything that is not a finite positive number outright rather than
 * coercing it: `max_tokens` reaches us from an untrusted body, and a NaN
 * propagated into an estimate would make the comparison against the balance
 * false in BOTH directions and silently disable the gate.
 */
export function assumedOutputTokens(maxTokens?: unknown): number {
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return ASSUMED_OUTPUT_TOKENS;
  }
  return Math.max(Math.ceil(maxTokens), ASSUMED_OUTPUT_TOKENS);
}

/**
 * Characters of prompt to price.
 *
 * `prompt` is a union: a plain string, or ARCA-0011 content blocks. The
 * original estimate read `prompt?.length`, which on an array is the number of
 * BLOCKS — a two-block multi-modal prompt of 40 000 characters priced as
 * "2 characters". Not a rounding error; a hole big enough to drive traffic
 * through. An image block has no character length of its own, so it is charged
 * a flat allowance rather than nothing.
 */
export function promptCharLength(prompt: string | ContentBlock[] | undefined): number {
  if (prompt == null) return 0;
  if (typeof prompt === 'string') return prompt.length;
  if (!Array.isArray(prompt)) return 0;
  return prompt.reduce((total, block) => {
    if (block?.type === 'text') return total + (block.text?.length ?? 0);
    // An image costs real input tokens that no character count can express.
    // A flat allowance keeps the estimate pessimistic rather than free.
    if (block?.type === 'image_url') return total + IMAGE_BLOCK_CHAR_ALLOWANCE;
    return total;
  }, 0);
}

/**
 * Chars charged for one image block. Roughly 1 000 tokens, the order of
 * magnitude the major providers bill a modest image at.
 */
const IMAGE_BLOCK_CHAR_ALLOWANCE = 4_000;

/**
 * Estimate the USD cost of a request. `pricing` is the catalogue row for the
 * target model, or null/undefined when the model is not in the catalogue.
 */
export function estimateCostUsd(
  promptLength: number,
  pricing?: CatalogPricing | null,
  options: EstimateOptions = {},
): number {
  if (!pricing || (pricing.inputPerMTok == null && pricing.outputPerMTok == null)) {
    return UNKNOWN_MODEL_ESTIMATE_USD;
  }
  const inputTokens = Math.ceil(Math.max(promptLength, 0) / CHARS_PER_TOKEN);
  const outputTokens = assumedOutputTokens(options.maxTokens);
  const inputCost = ((pricing.inputPerMTok ?? 0) * inputTokens) / 1_000_000;
  const outputCost = ((pricing.outputPerMTok ?? 0) * outputTokens) / 1_000_000;
  const total = inputCost + outputCost;
  // A catalogued FREE model legitimately estimates to zero, and a zero estimate
  // must remain affordable on a zero balance — refusing a free call for lack of
  // funds would be nonsense.
  return total;
}

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
 */

/** Rough chars-per-token. Only ever used to size an estimate, never a charge. */
const CHARS_PER_TOKEN = 4;

/** Output tokens assumed when the real length cannot be known yet. */
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

/**
 * Estimate the USD cost of a request. `pricing` is the catalogue row for the
 * target model, or null/undefined when the model is not in the catalogue.
 */
export function estimateCostUsd(promptLength: number, pricing?: CatalogPricing | null): number {
  if (!pricing || (pricing.inputPerMTok == null && pricing.outputPerMTok == null)) {
    return UNKNOWN_MODEL_ESTIMATE_USD;
  }
  const inputTokens = Math.ceil(Math.max(promptLength, 0) / CHARS_PER_TOKEN);
  const inputCost = ((pricing.inputPerMTok ?? 0) * inputTokens) / 1_000_000;
  const outputCost = ((pricing.outputPerMTok ?? 0) * ASSUMED_OUTPUT_TOKENS) / 1_000_000;
  const total = inputCost + outputCost;
  // A catalogued FREE model legitimately estimates to zero, and a zero estimate
  // must remain affordable on a zero balance — refusing a free call for lack of
  // funds would be nonsense.
  return total;
}

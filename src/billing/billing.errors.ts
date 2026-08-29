/**
 * ARAS-0064 — billing failure modes.
 *
 * Insufficient credit is a normal, expected answer to a request, not a crash:
 * the agent asking for work must be able to tell "you are out of money" apart
 * from "the connector broke", and retry logic must not treat the former as
 * transient. A distinct error type is what makes that distinction reachable by
 * a caller.
 */

export class InsufficientCreditsError extends Error {
  readonly code = 'insufficient_credits';

  constructor(
    readonly apiKeyId: string,
    readonly balanceUsd: string,
    readonly requiredUsd: string,
  ) {
    super(
      `insufficient credits: balance ${balanceUsd} USD is below the ${requiredUsd} USD required for this request`,
    );
    this.name = 'InsufficientCreditsError';
  }
}

/**
 * BILL-0008 — a reversal that must not be posted.
 *
 * Distinct from a crash for the same reason `InsufficientCreditsError` is:
 * "there is no such payment", "that payment is already fully reversed" and
 * "you cannot reverse a charge" are all correct answers to a well-formed
 * request, and a caller has to be able to tell them from the connector
 * breaking. `reason` is a stable code so the payments module can branch on it
 * without parsing a message.
 */
export class ReversalRefusedError extends Error {
  readonly code = 'reversal_refused';

  constructor(
    readonly reason:
      | 'original_not_found'
      | 'original_not_reversible'
      | 'exceeds_original'
      | 'invalid_amount',
    message: string,
  ) {
    super(message);
    this.name = 'ReversalRefusedError';
  }
}

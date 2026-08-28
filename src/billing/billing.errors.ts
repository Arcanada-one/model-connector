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

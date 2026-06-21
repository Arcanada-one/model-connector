// CONN-0223 — Cascade profile definitions and candidate parsing.

export interface CascadeCandidate {
  connector: string;
  model: string;
  tier: 'free' | 'paid';
}

/**
 * Parse the raw cascade order string into an ordered candidate list.
 * Format: "connector:model:tier,connector:model:tier,..."
 * Example: "openmodel:deepseek-v4-flash:free,openrouter:meta-llama/llama-4-maverick:free,openrouter:deepseek-v4-flash:paid"
 */
export function parseCascadeOrder(raw: string): CascadeCandidate[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      // connector may not contain ':', model may contain '/' but not ':'
      // Format is: connector:model:tier  (exactly 3 colon-separated parts)
      const colonIdx = entry.indexOf(':');
      if (colonIdx === -1) {
        throw new Error(`Invalid cascade entry (missing colon): "${entry}"`);
      }
      const connector = entry.slice(0, colonIdx);
      const rest = entry.slice(colonIdx + 1);
      const lastColon = rest.lastIndexOf(':');
      if (lastColon === -1) {
        throw new Error(`Invalid cascade entry (missing tier): "${entry}"`);
      }
      const model = rest.slice(0, lastColon);
      const tier = rest.slice(lastColon + 1);
      if (tier !== 'free' && tier !== 'paid') {
        throw new Error(`Invalid cascade tier "${tier}" in entry: "${entry}"`);
      }
      if (!connector || !model) {
        throw new Error(`Invalid cascade entry (empty connector or model): "${entry}"`);
      }
      return { connector, model, tier } as CascadeCandidate;
    });
}

/**
 * Validate that no paid candidate appears before all free candidates.
 * This is a safety check — paid entries must come after free ones.
 */
export function validateFreeBeforePaid(candidates: CascadeCandidate[]): void {
  let seenPaid = false;
  for (const candidate of candidates) {
    if (candidate.tier === 'paid') {
      seenPaid = true;
    } else if (seenPaid) {
      throw new Error(
        `Cascade order violation: free candidate "${candidate.connector}:${candidate.model}" appears after a paid candidate`,
      );
    }
  }
}

export interface CascadeConfig {
  lowReasoningOrder: string;
  paidEnabled: boolean;
}

/**
 * Build the candidate list for the low-reasoning profile.
 * Reads from env via the provided config, filters out paid entries when
 * CASCADE_PAID_ENABLED=false.
 */
export function buildLowReasoningCandidates(config: CascadeConfig): CascadeCandidate[] {
  const all = parseCascadeOrder(config.lowReasoningOrder);
  const candidates = config.paidEnabled ? all : all.filter((c) => c.tier === 'free');
  validateFreeBeforePaid(candidates);
  return candidates;
}

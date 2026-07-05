// CONN-0223 — OpenModel model catalogue (static; no live API fetch in V-AC-2).
// CONN-0244 — OpenModel is a PAID gateway: it has NO free models (operator balance went
// negative because MC falsely tagged deepseek-v4-flash free). The free-model default is now
// EMPTY, and every catalogue entry carries a non-zero price_multiplier so nothing here is
// classified `free` in the catalog. Override via OPENMODEL_FREE_MODELS only if the account
// genuinely gets a free allowance from the provider.

export const OPENMODEL_FREE_MODELS_DEFAULT: string[] = [];

/**
 * Build the list of free models from an optional CSV env override.
 * Falls back to OPENMODEL_FREE_MODELS_DEFAULT when the string is empty/absent.
 */
export function buildFreeModels(envCsv?: string): string[] {
  if (!envCsv || envCsv.trim() === '') {
    return [...OPENMODEL_FREE_MODELS_DEFAULT];
  }
  const parsed = envCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...OPENMODEL_FREE_MODELS_DEFAULT];
}

// price_multiplier: 0 = free, >0 = paid (relative baseline; 1 = provider baseline rate).
// CONN-0244 — deepseek-v4-flash moved 0 → 1: OpenModel bills it at the provider rate, it is
// NOT free. All OpenModel entries are now paid (>0).
export const OPENMODEL_CATALOGUE: { id: string; price_multiplier: number }[] = [
  { id: 'deepseek-v4-flash', price_multiplier: 1 },
  { id: 'deepseek-r2', price_multiplier: 1 },
  { id: 'qwen3-235b', price_multiplier: 1 },
];

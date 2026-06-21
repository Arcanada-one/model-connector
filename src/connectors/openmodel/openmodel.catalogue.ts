// CONN-0223 — OpenModel free-model catalogue (static; no live API fetch in V-AC-2).

export const OPENMODEL_FREE_MODELS_DEFAULT: string[] = ['deepseek-v4-flash'];

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

export const OPENMODEL_CATALOGUE: { id: string; price_multiplier: number }[] = [
  { id: 'deepseek-v4-flash', price_multiplier: 0 },
  { id: 'deepseek-r2', price_multiplier: 1 },
  { id: 'qwen3-235b', price_multiplier: 1 },
];

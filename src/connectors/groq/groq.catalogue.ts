// CONN-1672 — Groq free-tier chat allowlist.
//
// Groq's inference API is genuinely $0 (rate-limited) for its chat + moderation
// families — https://console.groq.com/docs/openai (free API with rate limits).
// BUT Groq's /openai/v1/models listing also reports list-pricing
// (`pricing.prompt` / `pricing.completion`) for those same models. The catalog
// tier derivation (`catalog-mapper.deriveTier`) rule 1 — both prices known and
// any > 0 → PAID — reads that list-price and OVERRIDES the provider-native free
// flag, so a genuinely-free groq chat model lands in the catalog as `tier=paid`
// (only the 3 groq models with NULL list-pricing — allam-2-7b, groq/compound,
// groq/compound-mini — survived as free before this fix).
//
// The fix (CONN-1672): for a model on this operator-curated allowlist, the groq
// connector SUPPRESSES the list-price (reports `pricing: null`) so `deriveTier`
// falls through to rule 2 (provider-native free flag → free) and marks it free.
//
// CONN-0244-safe: this is an EXPLICIT, operator-curated allowlist — NOT a
// blanket free-flag override. A groq model NOT on this list keeps its
// list-pricing and stays `tier=paid`. Only the curated chat models below are
// suppressed to catalog-free. (CONN-0244 was the false-free regression that
// burned the operator's balance by tagging a paid gateway `:free`; an explicit
// per-model allowlist is the sanctioned way to mark genuinely-$0 models free.)

// The operator-curated default free-tier groq chat models. Override at runtime
// via the GROQ_FREE_MODELS env CSV (see env.schema.ts, which uses
// GROQ_FREE_MODELS_DEFAULT_CSV below as its documented default).
export const GROQ_FREE_MODELS_DEFAULT: string[] = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-prompt-guard-2-22m',
  'meta-llama/llama-prompt-guard-2-86m',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-safeguard-20b',
  'qwen/qwen3-32b',
  'qwen/qwen3.6-27b',
  'allam-2-7b',
];

// Single source of truth for env.schema.ts's GROQ_FREE_MODELS default — keeps
// the schema default and the connector's built-in fallback drift-free.
export const GROQ_FREE_MODELS_DEFAULT_CSV = GROQ_FREE_MODELS_DEFAULT.join(',');

/**
 * Build the groq free-tier chat allowlist from an optional CSV env override.
 * Mirrors `openmodel.catalogue.buildFreeModels`: comma-split, trim, drop
 * empties. Falls back to GROQ_FREE_MODELS_DEFAULT when the string is
 * empty/absent so the operator-curated default is always in effect unless the
 * operator explicitly narrows/replaces it.
 */
export function buildGroqFreeModels(envCsv?: string): string[] {
  if (!envCsv || envCsv.trim() === '') {
    return [...GROQ_FREE_MODELS_DEFAULT];
  }
  const parsed = envCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...GROQ_FREE_MODELS_DEFAULT];
}

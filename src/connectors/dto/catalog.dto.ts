import { z } from 'zod';

// ─── CONN-0226 — catalog endpoint response schema ─────────────────────────────
// ─── CONN-0232 — modality dimension + derived tags + type/connector filters ───

/**
 * Model modality (a.k.a. `type`). Distinct from the connector's transport
 * `type: 'cli' | 'api'` (ConnectorCapabilities.type) — that is HOW we reach the
 * provider; this is WHAT the model does.
 *
 * `rerank` is a reserved enum member: there is no rerank connector in MC yet
 * (research R7), so the catalog emits zero rerank entries today. The value is
 * accepted by the schema so a future connector needs no Class-A change.
 */
export const MODEL_MODALITY_VALUES = [
  'chat',
  'embedding',
  'image_generation',
  'speech_to_text',
  'text_to_speech',
  // CONN-0238 — `video` covers grok-imagine-video; `moderation` covers groq
  // llama-prompt-guard safety classifiers. Both are additive (Class B): the Zod
  // enum is open to new members without a Class-A migration.
  'video',
  'moderation',
  'rerank',
] as const;

export const ModelModalitySchema = z.enum(MODEL_MODALITY_VALUES);
export type ModelModality = (typeof MODEL_MODALITY_VALUES)[number];

/**
 * CONN-0238 — normalised model pricing surfaced from the provider's live
 * `/models` API. Token-priced models are normalised to USD per 1,000,000 tokens
 * (`unit: 'per_1m_tokens'`); each field is null when the provider does not
 * publish it. NEVER invented — populated only from a machine source (anti-
 * fabrication). Non-token price models (STT $/hour, TTS $/char) keep `unit`
 * labelled and the per-MTok fields null rather than mislabel an ambiguous rate.
 */
export const ModelPricingSchema = z.object({
  inputPerMTok: z.number().nullable(),
  outputPerMTok: z.number().nullable(),
  unit: z.string(),
});

export type ModelPricing = z.infer<typeof ModelPricingSchema>;

/**
 * CONN-0238 — normalise a provider's per-token price (a decimal string such as
 * groq/openrouter `pricing.prompt = "0.00000059"`) to USD per 1,000,000 tokens,
 * rounded to 6 decimals to kill IEEE-754 noise (0.00000059 × 1e6 = 0.5899999…).
 * Returns null for an absent/empty/non-numeric input (anti-fabrication — never
 * invents a price). A literal "0" maps to 0 (genuinely free), not null.
 */
export function normalizePerMTokPrice(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Number((raw * 1_000_000).toFixed(6)) : null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const perToken = Number(raw);
  if (!Number.isFinite(perToken)) return null;
  return Number((perToken * 1_000_000).toFixed(6));
}

/**
 * Per-model entry returned in the catalog response.
 *
 * Design decisions:
 * - `rateLimits` is null when the connector does not expose live RPM/TPM data.
 *   We do not invent numbers — only surface what a connector actually reports.
 * - `free` is true when the model appears in the connector's freeModels list
 *   OR when its price_multiplier is 0 (OpenModel catalogue).
 * - `cheap` is true when the model is free OR price_multiplier <= 1 (low tier).
 * - `modality` classifies the model family (CONN-0232).
 * - `tags` are DERIVED only this phase (cost:* / cap:* / modality:*). No measured
 *   ("perf:fast") or curated ("tier:recommended") tags yet — those need a data
 *   source that does not exist now (research R1/R2).
 */
export const CatalogModelEntrySchema = z.object({
  /** Logical connector name (e.g. "openmodel", "groq", "claude-code"). */
  connector: z.string(),
  /** Model identifier as understood by the connector. */
  model: z.string(),
  /** Model family / modality (CONN-0232). */
  modality: ModelModalitySchema,
  /**
   * Derived, namespaced tags (CONN-0232). Namespaces: `cost:`, `cap:`,
   * `modality:`. Reproducible from the other fields — never fabricated.
   */
  tags: z.array(z.string()),
  /** Whether the model is on the free tier. */
  free: z.boolean(),
  /** Whether the model is free or low-cost (free + low price tier). */
  cheap: z.boolean(),
  /**
   * Price multiplier relative to a baseline unit cost.
   * 0 = free; 1 = standard; null = unknown.
   */
  priceMultiplier: z.number().nullable(),
  /**
   * Known rate limits. Null when the connector does not expose this data —
   * absent values are never invented.
   */
  rateLimits: z
    .object({
      requestsPerMinute: z.number().int().positive().nullable(),
      tokensPerMinute: z.number().int().positive().nullable(),
    })
    .nullable(),
  /**
   * CONN-0238 — real pricing from the provider's live `/models` API (groq /
   * openrouter expose per-token pricing; openmodel/grok do not). Null when no
   * machine price source exists. `.default(null)` keeps pre-CONN-0238 entry
   * literals valid while guaranteeing the field is always present on output.
   */
  pricing: ModelPricingSchema.nullable().default(null),
  /** CONN-0238 — provider-published context window (tokens). Null if unknown. */
  contextWindow: z.number().int().positive().nullable().default(null),
  /** CONN-0238 — provider-published max output/completion tokens. Null if unknown. */
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  /**
   * Capabilities inherited from the connector.
   * A model shares its connector's capabilities unless overridden.
   */
  capabilities: z.object({
    supportsStreaming: z.boolean(),
    supportsJsonSchema: z.boolean(),
    supportsTools: z.boolean(),
  }),
  /**
   * How to route. `connector` + `model` identify the route; `endpoint` is the
   * REAL invocation path so non-chat families are not misrepresented as the
   * chat `/execute` route (anti-fabrication — CONN-0232). Chat/embedding omit
   * `endpoint` (the standard `/execute` path applies); image/STT/TTS set it.
   */
  routing: z.object({
    connector: z.string(),
    model: z.string(),
    endpoint: z.string().optional(),
  }),
  /**
   * Whether this specific model is currently callable. Per-MODEL (CONN-0232 R10):
   * true only when the connector is reachable AND this model's circuit breaker
   * is not open. A connector whose `/health` route 404s but whose API is
   * reachable is NOT blanket-offline.
   */
  available: z.boolean(),
});

export type CatalogModelEntry = z.infer<typeof CatalogModelEntrySchema>;

/** Full catalog response envelope. */
export const CatalogResponseSchema = z.object({
  models: z.array(CatalogModelEntrySchema),
  /** ISO-8601 timestamp of when this catalog snapshot was generated. */
  generatedAt: z.string().datetime(),
  /** Number of models returned (after filters). */
  count: z.number().int().nonnegative(),
});

export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;

// ─── Filter query-param schema ────────────────────────────────────────────────

/**
 * Recognized capability filter values for the `capability` query param.
 * Maps to boolean fields on ConnectorCapabilities.
 */
export const CAPABILITY_FILTER_VALUES = [
  'supportsJsonSchema',
  'supportsTools',
  'supportsStreaming',
] as const;

export type CapabilityFilterValue = (typeof CAPABILITY_FILTER_VALUES)[number];

const flagTransform = (v: string | undefined) => v === 'true' || v === '1' || v === '';

export const CatalogFiltersSchema = z.object({
  /** Return only free-tier models. */
  free: z.string().optional().transform(flagTransform),
  /** Return free and low-cost models. */
  cheap: z.string().optional().transform(flagTransform),
  /** Filter to models whose connector supports this capability. */
  capability: z.enum(CAPABILITY_FILTER_VALUES).optional(),
  /**
   * Filter by modality. Canonical param is `?modality=`; `?type=` is accepted as
   * an alias (the field is named `modality` but the operator brief said "type").
   * The controller maps `type` → `modality` before parsing.
   */
  modality: ModelModalitySchema.optional(),
  /** Filter by connector name (exact match on the `connector` field). */
  connector: z.string().min(1).optional(),
  /** Exact-match a single tag (e.g. `cost:free`). */
  tag: z.string().min(1).optional(),
  /** Namespace-prefix match (e.g. `group=cost` → any `cost:*`). */
  group: z.string().min(1).optional(),
});

export type CatalogFilters = z.infer<typeof CatalogFiltersSchema>;

// ─── Derived-tag + filter helpers (pure, reused for connector + static entries) ─

/**
 * Build the derived, namespaced tag list for an entry. Reproducible from the
 * entry's own fields — no external lookup, no fabrication.
 */
export function buildDerivedTags(input: {
  modality: ModelModality;
  free: boolean;
  cheap: boolean;
  capabilities: { supportsStreaming: boolean; supportsJsonSchema: boolean; supportsTools: boolean };
  // CONN-0244 — false ⇒ the provider is READ-only (visible, not routable). Defaults to true
  // so existing callers (static image/STT/TTS entries) are unaffected.
  routable?: boolean;
}): string[] {
  const tags: string[] = [`modality:${input.modality}`];
  if (input.free) tags.push('cost:free');
  if (input.cheap) tags.push('cost:cheap');
  if (input.capabilities.supportsStreaming) tags.push('cap:streaming');
  if (input.capabilities.supportsTools) tags.push('cap:tools');
  if (input.capabilities.supportsJsonSchema) tags.push('cap:json-schema');
  if (input.routable === false) tags.push('access:read-only');
  return tags;
}

/**
 * Apply the catalog filters to a single entry. Shared by connector-derived and
 * static (image-gen/STT/TTS) entries so semantics are identical everywhere.
 *
 * `group` uses a delimiter-safe prefix so `group=cost` does NOT match a
 * hypothetical `cost-something:` tag (consilium R3 pitfall).
 */
export function entryMatchesFilters(entry: CatalogModelEntry, filters: CatalogFilters): boolean {
  if (filters.free && !entry.free) return false;
  if (filters.cheap && !entry.cheap) return false;
  if (filters.capability && !entry.capabilities[filters.capability]) return false;
  if (filters.modality && entry.modality !== filters.modality) return false;
  if (filters.connector && entry.connector !== filters.connector) return false;
  if (filters.tag && !entry.tags.includes(filters.tag)) return false;
  if (filters.group) {
    const prefix = filters.group.endsWith(':') ? filters.group : `${filters.group}:`;
    if (!entry.tags.some((t) => t.startsWith(prefix))) return false;
  }
  return true;
}

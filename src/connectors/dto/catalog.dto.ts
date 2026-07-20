import { z } from 'zod';

// ─── CONN-0226 — catalog endpoint response schema ─────────────────────────────

/**
 * Per-model entry returned in the catalog response.
 *
 * Design decisions:
 * - `rateLimits` is null when the connector does not expose live RPM/TPM data.
 *   We do not invent numbers — only surface what a connector actually reports.
 * - `free` is true when the model appears in the connector's freeModels list
 *   OR when its price_multiplier is 0 (OpenModel catalogue).
 * - `cheap` is true when the model is free OR price_multiplier <= 1 (low tier).
 */
export const CatalogModelEntrySchema = z.object({
  /** Logical connector name (e.g. "openmodel", "groq", "claude-code"). */
  connector: z.string(),
  /** Model identifier as understood by the connector. */
  model: z.string(),
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
   * Capabilities inherited from the connector.
   * A model shares its connector's capabilities unless overridden.
   */
  capabilities: z.object({
    supportsStreaming: z.boolean(),
    supportsJsonSchema: z.boolean(),
    supportsTools: z.boolean(),
  }),
  /** How to route: pass connector + model to the /execute endpoint. */
  routing: z.object({
    connector: z.string(),
    model: z.string(),
  }),
  /** Whether the connector is currently healthy (from getStatus). */
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

export const CatalogFiltersSchema = z.object({
  /** Return only free-tier models. */
  free: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1' || v === ''),
  /** Return free and low-cost models. */
  cheap: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1' || v === ''),
  /** Filter to models whose connector supports this capability. */
  capability: z.enum(CAPABILITY_FILTER_VALUES).optional(),
});

export type CatalogFilters = z.infer<typeof CatalogFiltersSchema>;

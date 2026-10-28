/**
 * Processing-tier vocabulary for request/response logging (#6664).
 *
 * Normalization follows the #5704 convention: lowercase, trim, map aliases to
 * the public OpenAI processing vocabulary, and never invent a tier — unknown
 * input becomes `unknown`.
 *
 * Public values: `standard` | `flex` | `batch` | `fast` | `unknown`.
 * `priority` is accepted as an alias of `fast` (OpenAI renamed Priority → Fast
 * on 2026-07-30). `default` / `auto` / empty map to `standard`.
 */

export const PROCESSING_TIERS = ['standard', 'flex', 'batch', 'fast', 'unknown'] as const;
export type ProcessingTier = (typeof PROCESSING_TIERS)[number];

const ALIASES: Record<string, ProcessingTier> = {
  standard: 'standard',
  default: 'standard',
  auto: 'standard',
  flex: 'flex',
  batch: 'batch',
  fast: 'fast',
  priority: 'fast',
};

/**
 * Normalize a raw provider / client tier token the way #5704 does for service
 * tiers: case-fold, strip, alias, otherwise `unknown`.
 */
export function normalizeProcessingTier(raw: unknown): ProcessingTier {
  if (raw == null) return 'standard';
  if (typeof raw !== 'string') return 'unknown';
  const key = raw.trim().toLowerCase();
  if (key === '') return 'standard';
  return ALIASES[key] ?? 'unknown';
}

/** Read a requested tier from a ConnectorRequest-shaped `extra` bag. */
export function requestedTierFromExtra(extra: Record<string, unknown> | undefined): ProcessingTier {
  if (!extra) return 'standard';
  const raw = extra.service_tier ?? extra.serviceTier ?? extra.processing_tier ?? extra.tier;
  return normalizeProcessingTier(raw);
}

/** Read an actual tier from a provider response payload / echo. */
export function actualTierFromResponse(raw: unknown): ProcessingTier {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if ('service_tier' in obj) return normalizeProcessingTier(obj.service_tier);
    if ('serviceTier' in obj) return normalizeProcessingTier(obj.serviceTier);
  }
  return normalizeProcessingTier(raw);
}

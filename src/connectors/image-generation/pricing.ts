import type { ModelId } from './types';

/**
 * Pricing snapshot (USD per image). Source: CONN-0052 plan §5.9.
 * Update last_validated when re-checking provider pricing pages.
 */
export const PRICING_TABLE: Partial<Record<ModelId | string, number>> = {
  'vertex:nano-banana': 0.039,
  'vertex:imagen-4-fast': 0.02,
  'vertex:imagen-4': 0.04,
  'vertex:imagen-4-ultra': 0.07,
  'replicate:flux-pro': 0.04,
  'openai:gpt-image-1-low': 0.011,
  'openai:gpt-image-1-medium': 0.06,
  'openai:gpt-image-1-high': 0.25,
  // CONN-0213: Fal.ai (source https://fal.ai/pricing; drift recipe CONN-0061)
  'fal-ai:flux/dev': 0.025,
  'fal-ai:flux-pro/v1.1': 0.04,
};

/**
 * Calculate total cost for generating `count` images with the given model.
 * Returns 0 for unknown models (fail-soft; let router handle validation).
 */
export function calculateCostUsd(modelId: string, count: number): number {
  const perImage = PRICING_TABLE[modelId] ?? 0;
  return perImage * count;
}

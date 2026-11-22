import type { ModelIdV2 } from './types';

/**
 * Pricing snapshot (USD per image). Source: CONN-0052 plan §5.9.
 * Update last_validated when re-checking provider pricing pages.
 */
export const PRICING_TABLE: Partial<Record<ModelIdV2 | string, number>> = {
  'vertex:nano-banana': 0.039,
  'vertex:imagen-4-fast': 0.02,
  'vertex:imagen-4': 0.04,
  'vertex:imagen-4-ultra': 0.07,
  'replicate:flux-pro': 0.04,
  // Conservative per-image routing estimate only; final cost uses response usage tokens.
  'openai:gpt-image-2.5-sunburst-low': 0.25,
  'openai:gpt-image-2.5-sunburst-medium': 0.25,
  'openai:gpt-image-2.5-sunburst-high': 0.25,
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

/** Calculate GPT Image 2.5 Sunburst cost from the API's token usage breakdown. */
export function calculateOpenAIImageCostUsd(usage: {
  input_tokens_details?: { image_tokens?: number; text_tokens?: number };
  output_tokens_details?: { image_tokens?: number; text_tokens?: number };
}): number | undefined {
  const input = usage.input_tokens_details;
  const output = usage.output_tokens_details;
  if (!input || !output) return undefined;
  const tokens = [input.image_tokens, input.text_tokens, output.image_tokens, output.text_tokens];
  if (!tokens.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    return undefined;
  }
  const [inputImage, inputText, outputImage, outputText] = tokens as number[];
  void outputText;
  return (inputImage * 4 + inputText * 2.5 + outputImage * 15) / 1_000_000;
}

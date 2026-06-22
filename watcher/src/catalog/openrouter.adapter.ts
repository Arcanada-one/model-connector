import { z } from 'zod';
import type { CatalogModel, ProviderCatalogAdapter } from './provider-adapter.js';

const numericString = z.string().regex(/^-?\d+(\.\d+)?$/);
const modelSchema = z.object({
  id: z.string().min(1),
  pricing: z.object({
    prompt: numericString,
    completion: numericString,
  }).passthrough(),
  context_length: z.number().int().positive().optional(),
  architecture: z.object({ modality: z.string().min(1).optional() }).passthrough().optional(),
}).passthrough();
const responseSchema = z.object({ data: z.array(modelSchema) }).passthrough();

export function normalizeOpenRouterCatalog(input: unknown): CatalogModel[] {
  return responseSchema.parse(input).data.map((model) => {
    const promptPrice = Number(model.pricing.prompt);
    const completionPrice = Number(model.pricing.completion);
    return {
      id: model.id,
      free: promptPrice === 0 && completionPrice === 0,
      promptPrice,
      completionPrice,
      contextLength: model.context_length,
      modality: model.architecture?.modality,
    };
  });
}

export class OpenRouterCatalogAdapter implements ProviderCatalogAdapter {
  readonly provider = 'openrouter';

  constructor(private readonly url = 'https://openrouter.ai/api/v1/models') {}

  async fetch(signal?: AbortSignal): Promise<CatalogModel[]> {
    const response = await fetch(this.url, { signal });
    if (!response.ok) throw new Error(`OpenRouter catalog request failed: ${response.status}`);
    return normalizeOpenRouterCatalog(await response.json());
  }
}

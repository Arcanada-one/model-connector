import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const TierEnum = z.enum(['cheap', 'mid', 'premium']);
export type Tier = z.infer<typeof TierEnum>;

export const ProviderIdEnum = z.enum(['vertex', 'replicate', 'openai-images']);
export type ProviderId = z.infer<typeof ProviderIdEnum>;

// Full model IDs used as routing keys
export type ModelId =
  | 'vertex:nano-banana'
  | 'vertex:imagen-4-fast'
  | 'vertex:imagen-4'
  | 'vertex:imagen-4-ultra'
  | 'replicate:flux-pro'
  | 'openai:gpt-image-1-low'
  | 'openai:gpt-image-1-medium'
  | 'openai:gpt-image-1-high';

// ─── Request / Result ─────────────────────────────────────────────────────────

export const imageGenerationRequestSchema = z.object({
  tier: TierEnum.default('mid'),
  prompt: z.string().min(1).max(8000),
  negativePrompt: z.string().max(2000).optional(),
  width: z.number().int().min(256).max(4096).optional(),
  height: z.number().int().min(256).max(4096).optional(),
  aspectRatio: z
    .enum(['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21', '2:3', '3:2', '5:4', '4:5'])
    .optional(),
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
  count: z.number().int().min(1).max(4).default(1),
  seed: z.number().int().optional(),
  outputFormat: z.enum(['url', 'inline_base64']).default('url'),
  outputAsync: z.enum(['auto', 'force', 'never']).default('auto'),
  maxBudgetUsd: z.number().gt(0).max(100).optional(),
  // Allow caller to pin a specific model (bypasses tier routing)
  model: z.string().optional(),
});

export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;

export interface RoutingDecision {
  chosenProvider: ProviderId;
  chosenModel: string;
  fallbackUsed: boolean;
  reason: string;
  /** Resolved candidate — enriched shape per creative-routing-policy §5. Stored as JSONB. */
  candidate: {
    modelId: string;
    providerId: ProviderId;
    tier: string;
  };
  /** Estimated cost for 1 image at this model (USD). 0 if model unknown in pricing table. */
  costUsd: number;
}

export interface ImageGenerationResult {
  requestId: string;
  status: 'completed' | 'queued';
  /** Present when status=completed */
  urls?: string[];
  /** Present when status=queued (async path) */
  jobId?: string;
  /** Poll endpoint for async */
  pollUrl?: string;
  costUsd: number;
  latencyMs?: number;
  routing: RoutingDecision;
}

// ─── Provider capabilities ────────────────────────────────────────────────────

export interface ImageProviderCapabilities {
  modelId: ModelId;
  /** Provider-side model identifier used in API URLs/bodies.
   *  Distinct from the internal `modelId` routing key.
   *  E.g. 'imagen-4.0-fast-generate-001' for 'vertex:imagen-4-fast'.
   *  Optional: connectors that do not use this field ignore it. */
  apiModelName?: string;
  provider: ProviderId;
  displayName: string;
  sizes: { width: number; height: number }[];
  aspectRatios: string[];
  maxPromptChars: number;
  supportsImg2Img: boolean;
  supportsSeed: boolean;
  watermark: 'always' | 'never' | 'optional';
  safetyPolicy: 'strict' | 'standard' | 'permissive';
  costPerImageUsd: number;
  latencyP95Ms: number;
  asyncThresholdMs: number;
  enabledByDefault: boolean;
  lastValidated: string; // ISO date
}

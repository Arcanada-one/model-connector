import { z } from 'zod';
import type { ImageProviderCapabilities, ModelId } from './types';

// ─── Zod schema for boot-time validation ─────────────────────────────────────

const capabilityEntrySchema = z.object({
  modelId: z.string(),
  apiModelName: z.string().optional(),
  provider: z.enum(['vertex', 'replicate', 'openai-images', 'fal-ai']),
  displayName: z.string().min(1),
  sizes: z
    .array(z.object({ width: z.number().int().positive(), height: z.number().int().positive() }))
    .min(1),
  aspectRatios: z.array(z.string()).min(1),
  maxPromptChars: z.number().int().positive(),
  supportsImg2Img: z.boolean(),
  supportsSeed: z.boolean(),
  watermark: z.enum(['always', 'never', 'optional']),
  safetyPolicy: z.enum(['strict', 'standard', 'permissive']),
  costPerImageUsd: z.number().positive(),
  latencyP95Ms: z.number().positive(),
  asyncThresholdMs: z.number().positive(),
  enabledByDefault: z.boolean(),
  lastValidated: z.string().min(1),
});

export const imageCapabilitiesSchema = z.record(z.string(), capabilityEntrySchema);

export type CapabilityRecord = Record<string, ImageProviderCapabilities>;

// ─── Static capabilities constant ─────────────────────────────────────────────

export const IMAGE_CAPABILITIES: Record<ModelId, ImageProviderCapabilities> = {
  'vertex:nano-banana': {
    modelId: 'vertex:nano-banana',
    // TODO(CONN-0052 Phase 3): Nano Banana = Gemini 2.5 Flash Image.
    // It uses `:generateContent` endpoint, not `:predict`. Separate connector needed.
    // See: GD-9 in INSIGHTS-CONN-0052.md
    apiModelName: 'gemini-2.5-flash-image',
    provider: 'vertex',
    displayName: 'Vertex Imagen Nano (Nano Banana)',
    sizes: [
      { width: 1024, height: 1024 },
      { width: 1024, height: 768 },
      { width: 768, height: 1024 },
    ],
    aspectRatios: ['1:1', '4:3', '3:4'],
    maxPromptChars: 2000,
    supportsImg2Img: false,
    supportsSeed: true,
    watermark: 'optional',
    safetyPolicy: 'standard',
    costPerImageUsd: 0.039,
    latencyP95Ms: 8000,
    asyncThresholdMs: 30000,
    enabledByDefault: true,
    lastValidated: '2026-05-08',
  },

  'vertex:imagen-4-fast': {
    modelId: 'vertex:imagen-4-fast',
    apiModelName: 'imagen-4.0-fast-generate-001', // Verified CONN-0052: HTTP 200, 1024×1024 PNG (761KB)
    provider: 'vertex',
    displayName: 'Vertex Imagen 4 Fast',
    sizes: [
      { width: 1024, height: 1024 },
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 1280, height: 720 },
    ],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    maxPromptChars: 4000,
    supportsImg2Img: false,
    supportsSeed: true,
    watermark: 'optional',
    safetyPolicy: 'standard',
    // NOTE: Google actual pricing $0.025/image (2026-05-08); gap <50% threshold, flagged
    costPerImageUsd: 0.02,
    latencyP95Ms: 6000,
    asyncThresholdMs: 30000,
    enabledByDefault: true,
    lastValidated: '2026-05-08',
  },

  'vertex:imagen-4': {
    modelId: 'vertex:imagen-4',
    apiModelName: 'imagen-4.0-generate-001', // Verified CONN-0052: HTTP 200
    provider: 'vertex',
    displayName: 'Vertex Imagen 4 Standard',
    sizes: [
      { width: 1024, height: 1024 },
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 2048, height: 2048 },
    ],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2'],
    maxPromptChars: 4000,
    supportsImg2Img: true,
    supportsSeed: true,
    watermark: 'optional',
    safetyPolicy: 'standard',
    costPerImageUsd: 0.04,
    latencyP95Ms: 15000,
    asyncThresholdMs: 30000,
    enabledByDefault: true,
    lastValidated: '2026-05-08',
  },

  'vertex:imagen-4-ultra': {
    modelId: 'vertex:imagen-4-ultra',
    apiModelName: 'imagen-4.0-ultra-generate-001', // Verified CONN-0052: HTTP 200
    provider: 'vertex',
    displayName: 'Vertex Imagen 4 Ultra',
    sizes: [
      { width: 2048, height: 2048 },
      { width: 3840, height: 2160 },
      { width: 2160, height: 3840 },
    ],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9', '9:21', '2:3', '3:2', '5:4', '4:5'],
    maxPromptChars: 8000,
    supportsImg2Img: true,
    supportsSeed: true,
    watermark: 'optional',
    safetyPolicy: 'standard',
    costPerImageUsd: 0.07,
    latencyP95Ms: 45000,
    asyncThresholdMs: 45000,
    enabledByDefault: true,
    lastValidated: '2026-05-08',
  },

  'replicate:flux-pro': {
    modelId: 'replicate:flux-pro',
    apiModelName: 'black-forest-labs/flux-pro', // Replicate model path used in /v1/models/{path}/predictions
    provider: 'replicate',
    displayName: 'FLUX.1 Pro (Replicate)',
    sizes: [
      { width: 1024, height: 1024 },
      { width: 1440, height: 1440 },
    ],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2'],
    maxPromptChars: 4000,
    supportsImg2Img: true,
    supportsSeed: true,
    watermark: 'never',
    safetyPolicy: 'standard',
    costPerImageUsd: 0.04,
    latencyP95Ms: 30000,
    asyncThresholdMs: 30000,
    enabledByDefault: true,
    lastValidated: '2026-05-07',
  },

  'openai:gpt-image-1-low': {
    modelId: 'openai:gpt-image-1-low',
    apiModelName: 'gpt-image-1', // Single real model ID; quality is a separate API param
    provider: 'openai-images',
    displayName: 'GPT Image 1 Low Quality',
    sizes: [
      { width: 1024, height: 1024 },
      { width: 1792, height: 1024 },
      { width: 1024, height: 1792 },
    ],
    aspectRatios: ['1:1', '16:9', '9:16'],
    maxPromptChars: 4000,
    supportsImg2Img: false,
    supportsSeed: false,
    watermark: 'never',
    safetyPolicy: 'strict',
    costPerImageUsd: 0.011,
    latencyP95Ms: 10000,
    asyncThresholdMs: 30000,
    // true = connector active; no creds → ProviderNotProvisionedError (not disabled)
    enabledByDefault: true,
    lastValidated: '2026-05-07',
  },

  'openai:gpt-image-1-medium': {
    modelId: 'openai:gpt-image-1-medium',
    apiModelName: 'gpt-image-1', // Single real model ID; quality is a separate API param
    provider: 'openai-images',
    displayName: 'GPT Image 1 Medium Quality',
    sizes: [
      { width: 1024, height: 1024 },
      { width: 1792, height: 1024 },
      { width: 1024, height: 1792 },
    ],
    aspectRatios: ['1:1', '16:9', '9:16'],
    maxPromptChars: 4000,
    supportsImg2Img: false,
    supportsSeed: false,
    watermark: 'never',
    safetyPolicy: 'strict',
    costPerImageUsd: 0.06,
    latencyP95Ms: 20000,
    asyncThresholdMs: 30000,
    enabledByDefault: true,
    lastValidated: '2026-05-07',
  },

  'openai:gpt-image-1-high': {
    modelId: 'openai:gpt-image-1-high',
    apiModelName: 'gpt-image-1', // Single real model ID; quality is a separate API param
    provider: 'openai-images',
    displayName: 'GPT Image 1 High Quality',
    sizes: [
      { width: 1024, height: 1024 },
      { width: 1792, height: 1024 },
      { width: 1024, height: 1792 },
    ],
    aspectRatios: ['1:1', '16:9', '9:16'],
    maxPromptChars: 8000,
    supportsImg2Img: false,
    supportsSeed: false,
    watermark: 'never',
    safetyPolicy: 'strict',
    costPerImageUsd: 0.25,
    latencyP95Ms: 60000,
    asyncThresholdMs: 60000,
    enabledByDefault: true,
    lastValidated: '2026-05-07',
  },

  // CONN-0213: Fal.ai (Phase 1 image only — video/audio in backlog CONN-0215/CONN-0216)
  'fal-ai:flux/dev': {
    modelId: 'fal-ai:flux/dev',
    apiModelName: 'flux/dev', // appended to https://fal.run/fal-ai/
    provider: 'fal-ai',
    displayName: 'FLUX.1 [dev] (Fal.ai schnell, 4-step)',
    // Fal.ai accepts a named image_size enum; widths/heights here are the
    // canonical mappings the connector emits via mapSize().
    sizes: [
      { width: 1024, height: 1024 }, // square_hd
      { width: 768, height: 1024 }, // portrait_4_3
      { width: 1024, height: 768 }, // landscape_4_3
    ],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    maxPromptChars: 4000,
    supportsImg2Img: false,
    supportsSeed: true,
    watermark: 'never',
    safetyPolicy: 'standard',
    costPerImageUsd: 0.025,
    latencyP95Ms: 1500, // Fixture 1: 0.6s inference; budget for queuing
    asyncThresholdMs: 30000,
    enabledByDefault: true,
    lastValidated: '2026-05-23',
  },

  'fal-ai:flux-pro/v1.1': {
    modelId: 'fal-ai:flux-pro/v1.1',
    apiModelName: 'flux-pro/v1.1',
    provider: 'fal-ai',
    displayName: 'FLUX.1 Pro v1.1 (Fal.ai premium)',
    sizes: [
      { width: 1024, height: 1024 },
      { width: 1024, height: 768 },
      { width: 768, height: 1024 },
    ],
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    maxPromptChars: 4000,
    supportsImg2Img: false,
    supportsSeed: true,
    watermark: 'never',
    safetyPolicy: 'standard',
    costPerImageUsd: 0.04,
    latencyP95Ms: 8000,
    asyncThresholdMs: 30000,
    enabledByDefault: true,
    lastValidated: '2026-05-23',
  },
};

// Boot-time validation (called from module init)
export function validateCapabilities(): void {
  imageCapabilitiesSchema.parse(IMAGE_CAPABILITIES);
}

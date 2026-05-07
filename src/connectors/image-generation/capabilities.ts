import { z } from 'zod';
import type { ImageProviderCapabilities, ModelId } from './types';

// ─── Zod schema for boot-time validation ─────────────────────────────────────

const capabilityEntrySchema = z.object({
  modelId: z.string(),
  provider: z.enum(['vertex', 'replicate', 'openai-images']),
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
    lastValidated: '2026-05-07',
  },

  'vertex:imagen-4-fast': {
    modelId: 'vertex:imagen-4-fast',
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
    costPerImageUsd: 0.02,
    latencyP95Ms: 6000,
    asyncThresholdMs: 30000,
    enabledByDefault: true,
    lastValidated: '2026-05-07',
  },

  'vertex:imagen-4': {
    modelId: 'vertex:imagen-4',
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
    lastValidated: '2026-05-07',
  },

  'vertex:imagen-4-ultra': {
    modelId: 'vertex:imagen-4-ultra',
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
    lastValidated: '2026-05-07',
  },

  'replicate:flux-pro': {
    modelId: 'replicate:flux-pro',
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
};

// Boot-time validation (called from module init)
export function validateCapabilities(): void {
  imageCapabilitiesSchema.parse(IMAGE_CAPABILITIES);
}

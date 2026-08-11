import { DEEPGRAM_AURA_ASTERIA_EN_METADATA } from './deepgram-aura-asteria.metadata';
import { DEEPGRAM_AURA_LUNA_EN_METADATA } from './deepgram-aura-luna.metadata';
import { DEEPGRAM_AURA_STELLA_EN_METADATA } from './deepgram-aura-stella.metadata';

export const DEEPGRAM_AURA_MODEL_IDS = [
  'aura-asteria-en',
  'aura-luna-en',
  'aura-stella-en',
] as const;

export type DeepgramAuraModelId = (typeof DEEPGRAM_AURA_MODEL_IDS)[number];

export const DEEPGRAM_AURA_METADATA = {
  'aura-asteria-en': DEEPGRAM_AURA_ASTERIA_EN_METADATA,
  'aura-luna-en': DEEPGRAM_AURA_LUNA_EN_METADATA,
  'aura-stella-en': DEEPGRAM_AURA_STELLA_EN_METADATA,
} as const satisfies Record<DeepgramAuraModelId, { readonly model: DeepgramAuraModelId }>;

export type DeepgramAuraMetadata = (typeof DEEPGRAM_AURA_METADATA)[DeepgramAuraModelId];

export class UnknownDeepgramAuraModelError extends Error {
  constructor() {
    super('Deepgram TTS model is not supported.');
    this.name = 'UnknownDeepgramAuraModelError';
  }
}

export function getDeepgramAuraMetadata(modelId: string): DeepgramAuraMetadata {
  if (!Object.prototype.hasOwnProperty.call(DEEPGRAM_AURA_METADATA, modelId)) {
    throw new UnknownDeepgramAuraModelError();
  }
  return DEEPGRAM_AURA_METADATA[modelId as DeepgramAuraModelId];
}

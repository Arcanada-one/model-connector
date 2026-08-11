export const TOGETHER_CARTESIA_SONIC_2_MODEL_ID = 'cartesia/sonic-2' as const;

/**
 * Retrieval-dated Together route facts. Character pricing is provenance only;
 * the public catalog remains token-oriented and therefore keeps pricing null.
 */
export const TOGETHER_CARTESIA_SONIC_2_METADATA = {
  model: TOGETHER_CARTESIA_SONIC_2_MODEL_ID,
  provider: 'together',
  modality: 'text_to_speech',
  observedModelIds: [TOGETHER_CARTESIA_SONIC_2_MODEL_ID],
  aliases: [],
  voiceKind: 'uuid',
  endpoint: '/v1/audio/speech',
  language: null,
  pricing: {
    usdPerMillionInputCharacters: 65,
    source: 'https://docs.together.ai/docs/inference/text-to-speech/overview',
    capturedAt: '2026-07-26',
  },
  freeTier: null,
  rateLimits: null,
  maxInputCharacters: null,
  sources: [
    'https://www.together.ai/models/cartesia-sonic',
    'https://docs.together.ai/reference/audio-speech',
    'https://docs.together.ai/docs/inference/text-to-speech/overview',
  ],
} as const;

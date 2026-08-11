export const TOGETHER_ORPHEUS_MODEL_ID = 'canopylabs/orpheus-3b-0.1-ft' as const;

export const TOGETHER_ORPHEUS_VOICES = [
  'tara',
  'leah',
  'jess',
  'leo',
  'dan',
  'mia',
  'zac',
  'zoe',
] as const;

export type TogetherOrpheusVoice = (typeof TOGETHER_ORPHEUS_VOICES)[number];

/**
 * Retrieval-dated facts that do not fit the token-oriented public catalog
 * schema. They are provenance only and are never used for runtime billing.
 */
export const TOGETHER_ORPHEUS_METADATA = {
  model: TOGETHER_ORPHEUS_MODEL_ID,
  modality: 'text_to_speech',
  observedProviders: ['huggingface', 'together'],
  observedModelIds: [TOGETHER_ORPHEUS_MODEL_ID],
  aliases: [],
  voices: TOGETHER_ORPHEUS_VOICES,
  language: 'en',
  pricing: {
    usdPerMillionInputCharacters: 15,
    source: 'https://docs.together.ai/docs/serverless/models',
    capturedAt: '2026-07-26',
  },
  freeTier: null,
  rateLimits: null,
  maxInputCharacters: null,
  huggingFaceRoute: 'provenance_only',
  sources: [
    'https://huggingface.co/canopylabs/orpheus-3b-0.1-ft',
    'https://github.com/canopyai/Orpheus-TTS',
    'https://docs.together.ai/docs/inference/text-to-speech/overview',
    'https://docs.together.ai/reference/audio-speech',
  ],
} as const;

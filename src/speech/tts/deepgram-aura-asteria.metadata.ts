export const DEEPGRAM_AURA_ASTERIA_EN_METADATA = {
  provider: 'deepgram',
  model: 'aura-asteria-en',
  aliases: [] as readonly string[],
  canonicalInventoryModality: 'audio_speech',
  modelConnectorModality: 'text_to_speech',
  family: 'Aura-1',
  language: 'English',
  maxInputCharacters: 2_000,
  capabilities: {
    rest: true,
    providerStreaming: true,
    connectorStreaming: false,
  },
  publicPaygProjectCeilings: {
    restConcurrency: 15,
    streamingConcurrency: 45,
  },
  pricing: {
    currency: 'USD',
    unit: 'per_1000_characters',
    payAsYouGo: 0.015,
    growth: 0.0135,
    free: false,
    accountTrialCreditUsd: 200,
    trialCreditIsModelFreeTier: false,
  },
  output: {
    encoding: 'linear16',
    container: 'wav',
    sampleRate: 24_000,
  },
  provenance: {
    retrievedAt: '2026-07-26',
    sources: {
      voiceCatalog: 'https://developers.deepgram.com/docs/tts-models',
      restApi: 'https://developers.deepgram.com/docs/text-to-speech',
      inputLimit: 'https://developers.deepgram.com/docs/streaming-text-to-speech',
      rateLimits: 'https://developers.deepgram.com/reference/api-rate-limits',
      pricing: 'https://deepgram.com/pricing',
      accountTrialCredit:
        'https://deepgram.com/learn/aura-text-to-speech-tts-api-voice-ai-agents-launch',
    },
  },
} as const;

export const CARTESIA_API_VERSION = '2026-03-01' as const;
export const CARTESIA_MODEL_SOURCE = 'https://docs.cartesia.ai/api-reference/tts/bytes' as const;

export const CARTESIA_TTS_MODELS = [
  { id: 'sonic-3.5', apiVersion: CARTESIA_API_VERSION, source: CARTESIA_MODEL_SOURCE },
  { id: 'sonic-3', apiVersion: CARTESIA_API_VERSION, source: CARTESIA_MODEL_SOURCE },
  { id: 'sonic-latest', apiVersion: CARTESIA_API_VERSION, source: CARTESIA_MODEL_SOURCE },
] as const;

export const DEEPGRAM_AURA_CATALOGUE = {
  sourceUrl: 'https://developers.deepgram.com/docs/tts-models',
  accessedAt: '2026-07-11',
  discovery: 'static-documentation',
  discoveryUrl: null,
  models: [
    {
      id: 'aura-2-thalia-en',
      language: 'en',
      status: 'generally-available',
    },
  ],
} as const;

export function getDeepgramAuraCatalogue(): typeof DEEPGRAM_AURA_CATALOGUE {
  return DEEPGRAM_AURA_CATALOGUE;
}

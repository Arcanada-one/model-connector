import { describe, expect, it } from 'vitest';
import { DEEPGRAM_AURA_STELLA_EN_METADATA } from './deepgram-aura-stella.metadata';

describe('DEEPGRAM_AURA_STELLA_EN_METADATA', () => {
  it('preserves exact identity, modality mapping, and empty proven aliases', () => {
    expect(DEEPGRAM_AURA_STELLA_EN_METADATA).toMatchObject({
      provider: 'deepgram',
      model: 'aura-stella-en',
      aliases: [],
      canonicalInventoryModality: 'audio_speech',
      modelConnectorModality: 'text_to_speech',
      family: 'Aura-1',
      language: 'English',
    });
  });

  it('records only the current official Stella voice traits', () => {
    expect(DEEPGRAM_AURA_STELLA_EN_METADATA.voice).toEqual({
      name: 'Stella',
      expressedGender: 'feminine',
      age: 'Adult',
      locale: 'en-us',
      accent: 'American',
      characteristics: ['Clear', 'Professional', 'Engaging'],
      useCases: ['Customer service'],
    });
  });

  it('records sourced Aura-1 capabilities, limits, pricing, and output', () => {
    expect(DEEPGRAM_AURA_STELLA_EN_METADATA.maxInputCharacters).toBe(2_000);
    expect(DEEPGRAM_AURA_STELLA_EN_METADATA.capabilities).toEqual({
      rest: true,
      providerStreaming: true,
      connectorStreaming: false,
    });
    expect(DEEPGRAM_AURA_STELLA_EN_METADATA.publicPaygProjectCeilings).toEqual({
      restConcurrency: 15,
      streamingConcurrency: 45,
    });
    expect(DEEPGRAM_AURA_STELLA_EN_METADATA.pricing).toEqual({
      currency: 'USD',
      unit: 'per_1000_characters',
      payAsYouGo: 0.015,
      growth: 0.0135,
      free: false,
      accountTrialCreditUsd: 200,
      trialCreditIsModelFreeTier: false,
    });
    expect(DEEPGRAM_AURA_STELLA_EN_METADATA.output).toEqual({
      encoding: 'linear16',
      container: 'wav',
      sampleRate: 24_000,
    });
  });

  it('pins retrieval date and official Deepgram source URLs', () => {
    expect(DEEPGRAM_AURA_STELLA_EN_METADATA.provenance.retrievedAt).toBe('2026-07-26');
    expect(Object.values(DEEPGRAM_AURA_STELLA_EN_METADATA.provenance.sources)).toEqual(
      expect.arrayContaining([
        'https://developers.deepgram.com/docs/tts-models',
        'https://developers.deepgram.com/docs/text-to-speech',
        'https://developers.deepgram.com/reference/api-rate-limits',
        'https://deepgram.com/pricing',
      ]),
    );
  });
});

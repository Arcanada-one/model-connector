import { describe, expect, it } from 'vitest';
import { DEEPGRAM_AURA_ASTERIA_EN_METADATA } from './deepgram-aura-asteria.metadata';

describe('DEEPGRAM_AURA_ASTERIA_EN_METADATA', () => {
  it('preserves the exact identity, modality mapping, and proven lack of aliases', () => {
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.provider).toBe('deepgram');
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.model).toBe('aura-asteria-en');
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.aliases).toEqual([]);
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.canonicalInventoryModality).toBe('audio_speech');
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.modelConnectorModality).toBe('text_to_speech');
  });

  it('records sourced capabilities and limits without inventing token metadata', () => {
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.family).toBe('Aura-1');
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.language).toBe('English');
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.maxInputCharacters).toBe(2_000);
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.capabilities).toEqual({
      rest: true,
      providerStreaming: true,
      connectorStreaming: false,
    });
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.publicPaygProjectCeilings).toEqual({
      restConcurrency: 15,
      streamingConcurrency: 45,
    });
  });

  it('separates character pricing and account credit from a model free tier', () => {
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.pricing).toEqual({
      currency: 'USD',
      unit: 'per_1000_characters',
      payAsYouGo: 0.015,
      growth: 0.0135,
      free: false,
      accountTrialCreditUsd: 200,
      trialCreditIsModelFreeTier: false,
    });
  });

  it('pins explicit output and official provenance', () => {
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.output).toEqual({
      encoding: 'linear16',
      container: 'wav',
      sampleRate: 24_000,
    });
    expect(DEEPGRAM_AURA_ASTERIA_EN_METADATA.provenance.retrievedAt).toBe('2026-07-26');
    expect(Object.values(DEEPGRAM_AURA_ASTERIA_EN_METADATA.provenance.sources)).toEqual(
      expect.arrayContaining([
        'https://developers.deepgram.com/docs/tts-models',
        'https://developers.deepgram.com/docs/text-to-speech',
        'https://developers.deepgram.com/reference/api-rate-limits',
        'https://deepgram.com/pricing',
      ]),
    );
  });
});

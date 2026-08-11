import { describe, expect, it } from 'vitest';
import {
  TOGETHER_CARTESIA_SONIC_2_METADATA,
  TOGETHER_CARTESIA_SONIC_2_MODEL_ID,
} from './together-cartesia-sonic-2.metadata';

describe('Together Cartesia Sonic 2 metadata', () => {
  it('preserves the exact canonical provider identity without aliases', () => {
    expect(TOGETHER_CARTESIA_SONIC_2_MODEL_ID).toBe('cartesia/sonic-2');
    expect(TOGETHER_CARTESIA_SONIC_2_METADATA).toMatchObject({
      model: 'cartesia/sonic-2',
      provider: 'together',
      modality: 'text_to_speech',
      observedModelIds: ['cartesia/sonic-2'],
      aliases: [],
      voiceKind: 'uuid',
      endpoint: '/v1/audio/speech',
    });
  });

  it('records only sourced character pricing and leaves unknown limits null', () => {
    expect(TOGETHER_CARTESIA_SONIC_2_METADATA.pricing).toEqual({
      usdPerMillionInputCharacters: 65,
      source: 'https://docs.together.ai/docs/inference/text-to-speech/overview',
      capturedAt: '2026-07-26',
    });
    expect(TOGETHER_CARTESIA_SONIC_2_METADATA.language).toBeNull();
    expect(TOGETHER_CARTESIA_SONIC_2_METADATA.freeTier).toBeNull();
    expect(TOGETHER_CARTESIA_SONIC_2_METADATA.rateLimits).toBeNull();
    expect(TOGETHER_CARTESIA_SONIC_2_METADATA.maxInputCharacters).toBeNull();
  });

  it('pins current primary sources without runtime catalog data', () => {
    expect(TOGETHER_CARTESIA_SONIC_2_METADATA.sources).toEqual([
      'https://www.together.ai/models/cartesia-sonic',
      'https://docs.together.ai/reference/audio-speech',
      'https://docs.together.ai/docs/inference/text-to-speech/overview',
    ]);
  });
});

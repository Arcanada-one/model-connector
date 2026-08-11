import { describe, expect, it } from 'vitest';
import {
  TOGETHER_ORPHEUS_METADATA,
  TOGETHER_ORPHEUS_MODEL_ID,
  TOGETHER_ORPHEUS_VOICES,
} from './together-orpheus.metadata';

describe('Together Orpheus 3B metadata', () => {
  it('preserves the exact canonical identity with no inferred aliases', () => {
    expect(TOGETHER_ORPHEUS_MODEL_ID).toBe('canopylabs/orpheus-3b-0.1-ft');
    expect(TOGETHER_ORPHEUS_METADATA).toMatchObject({
      model: 'canopylabs/orpheus-3b-0.1-ft',
      modality: 'text_to_speech',
      observedProviders: ['huggingface', 'together'],
      observedModelIds: ['canopylabs/orpheus-3b-0.1-ft'],
      aliases: [],
    });
  });

  it('uses only the eight evidenced English voices', () => {
    expect(TOGETHER_ORPHEUS_VOICES).toEqual([
      'tara',
      'leah',
      'jess',
      'leo',
      'dan',
      'mia',
      'zac',
      'zoe',
    ]);
  });

  it('records character pricing as provenance and leaves unknowns explicit', () => {
    expect(TOGETHER_ORPHEUS_METADATA.pricing).toEqual({
      usdPerMillionInputCharacters: 15,
      source: 'https://docs.together.ai/docs/serverless/models',
      capturedAt: '2026-07-26',
    });
    expect(TOGETHER_ORPHEUS_METADATA.freeTier).toBeNull();
    expect(TOGETHER_ORPHEUS_METADATA.rateLimits).toBeNull();
    expect(TOGETHER_ORPHEUS_METADATA.maxInputCharacters).toBeNull();
    expect(TOGETHER_ORPHEUS_METADATA.huggingFaceRoute).toBe('provenance_only');
  });
});

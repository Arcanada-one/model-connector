import { describe, expect, it } from 'vitest';
import {
  TOGETHER_TTS_MODEL_DEFINITIONS,
  type TogetherTtsModelId,
} from './together-tts.model-definitions';

describe('Together TTS closed model definitions', () => {
  it('contains exactly the two reviewed exact model identities', () => {
    expect(Object.keys(TOGETHER_TTS_MODEL_DEFINITIONS)).toEqual([
      'canopylabs/orpheus-3b-0.1-ft',
      'cartesia/sonic-2',
    ]);
  });

  it('binds every definition model to its exact key', () => {
    for (const [key, definition] of Object.entries(TOGETHER_TTS_MODEL_DEFINITIONS)) {
      expect(definition.model).toBe(key);
    }
  });

  it('exposes a compile-time closed model union', () => {
    const exact: TogetherTtsModelId = 'cartesia/sonic-2';
    expect(exact).toBe('cartesia/sonic-2');
  });
});

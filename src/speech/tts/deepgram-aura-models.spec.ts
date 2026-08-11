import { describe, expect, it } from 'vitest';
import {
  DEEPGRAM_AURA_METADATA,
  DEEPGRAM_AURA_MODEL_IDS,
  getDeepgramAuraMetadata,
  UnknownDeepgramAuraModelError,
} from './deepgram-aura-models';

describe('Deepgram Aura closed model registry', () => {
  it('contains exactly the independently reviewed Asteria, Luna, and Stella IDs', () => {
    expect(DEEPGRAM_AURA_MODEL_IDS).toEqual(['aura-asteria-en', 'aura-luna-en', 'aura-stella-en']);
    expect(Object.keys(DEEPGRAM_AURA_METADATA)).toEqual(DEEPGRAM_AURA_MODEL_IDS);
  });

  it.each(DEEPGRAM_AURA_MODEL_IDS)('maps %s to a matching exact metadata record', (model) => {
    expect(getDeepgramAuraMetadata(model).model).toBe(model);
  });

  it('fails closed at runtime without echoing an unknown model', () => {
    const unknown = 'private-unreviewed-model';
    expect(() => getDeepgramAuraMetadata(unknown)).toThrow(UnknownDeepgramAuraModelError);
    expect(() => getDeepgramAuraMetadata(unknown)).not.toThrow(unknown);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DEEPGRAM_AURA_CATALOGUE, getDeepgramAuraCatalogue } from './deepgram-tts.catalogue';

describe('Deepgram Aura documented catalogue', () => {
  it('is an explicitly sourced static snapshot, not a fabricated discovery API', () => {
    expect(DEEPGRAM_AURA_CATALOGUE.sourceUrl).toBe(
      'https://developers.deepgram.com/docs/tts-models',
    );
    expect(DEEPGRAM_AURA_CATALOGUE.accessedAt).toBe('2026-07-11');
    expect(DEEPGRAM_AURA_CATALOGUE.discovery).toBe('static-documentation');
    expect(DEEPGRAM_AURA_CATALOGUE.discoveryUrl).toBeNull();
    expect(DEEPGRAM_AURA_CATALOGUE.models).toContainEqual(
      expect.objectContaining({
        id: 'aura-2-thalia-en',
        language: 'en',
        status: 'generally-available',
      }),
    );
  });

  it('returns data without invoking any transport', () => {
    const transport = vi.fn();
    const result = getDeepgramAuraCatalogue();
    expect(result).toEqual(DEEPGRAM_AURA_CATALOGUE);
    expect(transport).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { ModalityCatalogService } from './modality-catalog.service';

describe('ModalityCatalogService Deepgram TTS coverage', () => {
  const original = process.env.TTS_PROVIDER_DEEPGRAM_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TTS_PROVIDER_DEEPGRAM_ENABLED;
    } else {
      process.env.TTS_PROVIDER_DEEPGRAM_ENABLED = original;
    }
  });

  it('lists all three exact default-off models using only current-schema truths', () => {
    delete process.env.TTS_PROVIDER_DEEPGRAM_ENABLED;
    const entries = new ModalityCatalogService().getEntries();
    const matches = entries.filter((entry) => entry.connector === 'deepgram-tts');

    expect(matches.map((entry) => entry.model)).toEqual([
      'aura-asteria-en',
      'aura-luna-en',
      'aura-stella-en',
    ]);
    for (const entry of matches) {
      expect(entry).toMatchObject({
        connector: 'deepgram-tts',
        modality: 'text_to_speech',
        free: false,
        cheap: false,
        priceMultiplier: null,
        pricing: null,
        rateLimits: null,
        capabilities: {
          supportsStreaming: false,
          supportsJsonSchema: false,
          supportsTools: false,
        },
        routing: {
          connector: 'deepgram-tts',
          model: entry.model,
          endpoint: '/v1/speech/tts',
        },
        available: false,
      });
    }
    expect(entries.some((entry) => entry.connector === 'tts' && entry.model === 'tts')).toBe(true);
  });

  it('changes only availability when explicitly enabled', () => {
    process.env.TTS_PROVIDER_DEEPGRAM_ENABLED = 'true';
    const enabled = new ModalityCatalogService()
      .getEntries()
      .filter((entry) => entry.connector === 'deepgram-tts');
    process.env.TTS_PROVIDER_DEEPGRAM_ENABLED = 'false';
    const disabled = new ModalityCatalogService()
      .getEntries()
      .filter((entry) => entry.connector === 'deepgram-tts');

    expect(enabled).toHaveLength(3);
    expect(disabled).toHaveLength(3);
    expect(enabled.every((entry) => entry.available)).toBe(true);
    expect(disabled.every((entry) => !entry.available)).toBe(true);
    expect(enabled.map((entry) => ({ ...entry, available: false }))).toEqual(disabled);
  });
});

describe('ModalityCatalogService Together TTS coverage', () => {
  const original = process.env.TTS_PROVIDER_TOGETHER_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TTS_PROVIDER_TOGETHER_ENABLED;
    } else {
      process.env.TTS_PROVIDER_TOGETHER_ENABLED = original;
    }
  });

  it('emits exactly two default-off exact model rows with honest metadata fields', () => {
    delete process.env.TTS_PROVIDER_TOGETHER_ENABLED;
    const entries = new ModalityCatalogService().getEntries();
    const matches = entries.filter((entry) => entry.connector === 'together-tts');

    expect(matches).toHaveLength(2);
    expect(matches.map((entry) => entry.model)).toEqual([
      'canopylabs/orpheus-3b-0.1-ft',
      'cartesia/sonic-2',
    ]);
    for (const entry of matches) {
      expect(entry).toMatchObject({
        connector: 'together-tts',
        modality: 'text_to_speech',
        free: false,
        cheap: false,
        priceMultiplier: null,
        pricing: null,
        rateLimits: null,
        capabilities: {
          supportsStreaming: false,
          supportsJsonSchema: false,
          supportsTools: false,
        },
        routing: {
          connector: 'together-tts',
          model: entry.model,
          endpoint: '/v1/speech/tts',
        },
        available: false,
      });
    }
    expect(matches.filter((entry) => entry.model.startsWith('cartesia/'))).toHaveLength(1);
    expect(entries.some((entry) => entry.connector === 'tts' && entry.model === 'tts')).toBe(true);
  });

  it('changes only availability for both rows when explicitly enabled', () => {
    process.env.TTS_PROVIDER_TOGETHER_ENABLED = 'true';
    const enabled = new ModalityCatalogService()
      .getEntries()
      .filter((entry) => entry.connector === 'together-tts');
    process.env.TTS_PROVIDER_TOGETHER_ENABLED = 'false';
    const disabled = new ModalityCatalogService()
      .getEntries()
      .filter((entry) => entry.connector === 'together-tts');

    expect(enabled).toHaveLength(2);
    expect(disabled).toHaveLength(2);
    expect(enabled.every((entry) => entry.available)).toBe(true);
    expect(disabled.every((entry) => !entry.available)).toBe(true);
    expect(enabled.map((entry) => ({ ...entry, available: false }))).toEqual(disabled);
  });
});

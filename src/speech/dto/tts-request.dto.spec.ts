import { describe, it, expect } from 'vitest';
import {
  DEEPGRAM_TTS_MAX_TEXT_CHARS,
  isDeepgramTtsRequest,
  ttsRequestSchema,
  TTS_MAX_TEXT_CHARS,
} from './tts-request.dto';

describe('ttsRequestSchema', () => {
  it('accepts minimal valid request with defaults', () => {
    const parsed = ttsRequestSchema.parse({ text: 'Hello, world.' });
    if (isDeepgramTtsRequest(parsed)) throw new Error('legacy request parsed as Deepgram');
    expect(parsed.speaker).toBe('xenia');
    expect(parsed.sample_rate).toBe(24_000);
    expect(parsed.speed).toBe(1.0);
  });

  it('accepts all 5 speakers', () => {
    for (const speaker of ['xenia', 'aidar', 'baya', 'kseniya', 'eugene'] as const) {
      expect(() => ttsRequestSchema.parse({ text: 'x', speaker })).not.toThrow();
    }
  });

  it('rejects empty text', () => {
    expect(() => ttsRequestSchema.parse({ text: '' })).toThrow();
  });

  it('rejects text exceeding 5000 chars', () => {
    expect(() => ttsRequestSchema.parse({ text: 'a'.repeat(TTS_MAX_TEXT_CHARS + 1) })).toThrow();
  });

  it('rejects unknown speaker', () => {
    expect(() => ttsRequestSchema.parse({ text: 'x', speaker: 'unknown' })).toThrow();
  });

  it('rejects invalid sample_rate', () => {
    expect(() => ttsRequestSchema.parse({ text: 'x', sample_rate: 44_100 })).toThrow();
  });

  it('rejects speed outside 0.5–2.0', () => {
    expect(() => ttsRequestSchema.parse({ text: 'x', speed: 0.4 })).toThrow();
    expect(() => ttsRequestSchema.parse({ text: 'x', speed: 2.1 })).toThrow();
  });

  it('rejects extra fields under strict mode', () => {
    expect(() => ttsRequestSchema.parse({ text: 'x', extra: 'field' })).toThrow();
  });

  it('accepts the exact Deepgram Aura Asteria request without legacy defaults', () => {
    const parsed = ttsRequestSchema.parse({
      provider: 'deepgram',
      model: 'aura-asteria-en',
      text: 'Hello from Asteria.',
    });
    expect(isDeepgramTtsRequest(parsed)).toBe(true);
    expect(parsed).toEqual({
      provider: 'deepgram',
      model: 'aura-asteria-en',
      text: 'Hello from Asteria.',
    });
  });

  it('accepts the exact Deepgram Aura Luna request without legacy defaults', () => {
    const parsed = ttsRequestSchema.parse({
      provider: 'deepgram',
      model: 'aura-luna-en',
      text: 'Hello from Luna.',
    });
    expect(isDeepgramTtsRequest(parsed)).toBe(true);
    expect(parsed).toEqual({
      provider: 'deepgram',
      model: 'aura-luna-en',
      text: 'Hello from Luna.',
    });
  });

  it('accepts the exact Deepgram Aura Stella request without legacy defaults', () => {
    const parsed = ttsRequestSchema.parse({
      provider: 'deepgram',
      model: 'aura-stella-en',
      text: 'Hello from Stella.',
    });
    expect(isDeepgramTtsRequest(parsed)).toBe(true);
    expect(parsed).toEqual({
      provider: 'deepgram',
      model: 'aura-stella-en',
      text: 'Hello from Stella.',
    });
  });

  it('accepts the Deepgram 2000-character boundary', () => {
    expect(() =>
      ttsRequestSchema.parse({
        provider: 'deepgram',
        model: 'aura-asteria-en',
        text: 'a'.repeat(DEEPGRAM_TTS_MAX_TEXT_CHARS),
      }),
    ).not.toThrow();
  });

  it.each([
    { provider: 'deepgram', model: 'aura-asteria-en', text: '' },
    { provider: 'deepgram', model: 'aura-asteria-en', text: 'a'.repeat(2_001) },
    { provider: 'deepgram', text: 'missing model' },
    { provider: 'deepgram', model: 'aura-unknown-en', text: 'wrong model' },
    { provider: 'other', model: 'aura-asteria-en', text: 'wrong provider' },
    {
      provider: 'deepgram',
      model: 'aura-asteria-en',
      text: 'extra field',
      speaker: 'xenia',
    },
  ])('rejects invalid Deepgram request %#', (request) => {
    expect(() => ttsRequestSchema.parse(request)).toThrow();
  });

  it('accepts the exact Together Orpheus model and all evidenced voices', () => {
    for (const voice of ['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe']) {
      expect(
        ttsRequestSchema.parse({
          provider: 'together',
          model: 'canopylabs/orpheus-3b-0.1-ft',
          text: 'Hello',
          voice,
        }),
      ).toEqual({
        provider: 'together',
        model: 'canopylabs/orpheus-3b-0.1-ft',
        text: 'Hello',
        voice,
      });
    }
  });

  it('accepts Cartesia Sonic 2 only with a UUID voice identity', () => {
    const request = {
      provider: 'together',
      model: 'cartesia/sonic-2',
      text: 'Hello',
      voice: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
    };

    expect(ttsRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects Cartesia display names, malformed UUIDs, and extra controls', () => {
    const request = {
      provider: 'together',
      model: 'cartesia/sonic-2',
      text: 'Hello',
      voice: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
    };

    expect(() =>
      ttsRequestSchema.parse({ ...request, voice: 'Skylar - Friendly Guide' }),
    ).toThrow();
    expect(() => ttsRequestSchema.parse({ ...request, voice: 'not-a-uuid' })).toThrow();
    expect(() => ttsRequestSchema.parse({ ...request, response_format: 'mp3' })).toThrow();
  });

  it('rejects unreviewed Together models, voices, and extra output controls', () => {
    const base = {
      provider: 'together',
      model: 'canopylabs/orpheus-3b-0.1-ft',
      text: 'Hello',
      voice: 'tara',
    };
    expect(() => ttsRequestSchema.parse({ ...base, model: 'canopylabs/other' })).toThrow();
    expect(() => ttsRequestSchema.parse({ ...base, voice: 'arbitrary' })).toThrow();
    expect(() => ttsRequestSchema.parse({ ...base, response_format: 'mp3' })).toThrow();
  });
});

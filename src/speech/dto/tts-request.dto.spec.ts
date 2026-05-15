import { describe, it, expect } from 'vitest';
import { ttsRequestSchema, TTS_MAX_TEXT_CHARS } from './tts-request.dto';

describe('ttsRequestSchema', () => {
  it('accepts minimal valid request with defaults', () => {
    const parsed = ttsRequestSchema.parse({ text: 'Hello, world.' });
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
});

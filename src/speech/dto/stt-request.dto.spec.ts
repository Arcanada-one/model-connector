import { describe, it, expect } from 'vitest';
import { sttRequestSchema, STT_ALLOWED_MIME_TYPES, STT_PROMPT_MAX_CHARS } from './stt-request.dto';

describe('sttRequestSchema', () => {
  it('accepts minimal valid payload (only mimeType)', () => {
    const parsed = sttRequestSchema.parse({ mimeType: 'audio/wav' });
    expect(parsed.mimeType).toBe('audio/wav');
    expect(parsed.language).toBeUndefined();
    expect(parsed.temperature).toBeUndefined();
  });

  it('accepts all whitelisted MIME types', () => {
    for (const mime of STT_ALLOWED_MIME_TYPES) {
      expect(() => sttRequestSchema.parse({ mimeType: mime })).not.toThrow();
    }
  });

  it('normalises MIME with codec suffix (audio/mp4;codecs=...) and accepts it', () => {
    const parsed = sttRequestSchema.parse({ mimeType: 'audio/mp4;codecs=mp4a.40.2' });
    expect(parsed.mimeType).toBe('audio/mp4');
  });

  it('rejects MIME outside whitelist (image/png)', () => {
    expect(() => sttRequestSchema.parse({ mimeType: 'image/png' })).toThrow();
  });

  it('rejects BCP-47 in wrong casing (EN-us, not en-US)', () => {
    expect(() => sttRequestSchema.parse({ mimeType: 'audio/wav', language: 'EN-us' })).toThrow();
  });

  it('accepts BCP-47 in valid forms (en, en-US)', () => {
    expect(() => sttRequestSchema.parse({ mimeType: 'audio/wav', language: 'en' })).not.toThrow();
    expect(() =>
      sttRequestSchema.parse({ mimeType: 'audio/wav', language: 'en-US' }),
    ).not.toThrow();
  });

  it('rejects empty model string', () => {
    expect(() => sttRequestSchema.parse({ mimeType: 'audio/wav', model: '' })).toThrow();
  });

  it('rejects prompt exceeding STT_PROMPT_MAX_CHARS', () => {
    expect(() =>
      sttRequestSchema.parse({
        mimeType: 'audio/wav',
        prompt: 'a'.repeat(STT_PROMPT_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  it('rejects temperature outside [0,1]', () => {
    expect(() => sttRequestSchema.parse({ mimeType: 'audio/wav', temperature: -0.1 })).toThrow();
    expect(() => sttRequestSchema.parse({ mimeType: 'audio/wav', temperature: 1.1 })).toThrow();
  });

  it('coerces stringified temperature from form-field input', () => {
    const parsed = sttRequestSchema.parse({ mimeType: 'audio/wav', temperature: '0.3' });
    expect(parsed.temperature).toBe(0.3);
  });

  it('rejects timeoutMs below 1s or above 5min', () => {
    expect(() => sttRequestSchema.parse({ mimeType: 'audio/wav', timeoutMs: 500 })).toThrow();
    expect(() => sttRequestSchema.parse({ mimeType: 'audio/wav', timeoutMs: 600_000 })).toThrow();
  });

  it('rejects unknown extra fields under strict mode', () => {
    expect(() => sttRequestSchema.parse({ mimeType: 'audio/wav', secretField: 'leak' })).toThrow();
  });
});

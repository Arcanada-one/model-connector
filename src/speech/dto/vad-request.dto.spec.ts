import { describe, it, expect } from 'vitest';
import { vadRequestSchema, VAD_MAX_AUDIO_BASE64_CHARS } from './vad-request.dto';

const validBase64 = 'AAAAAAAAAAAAAAAA';

describe('vadRequestSchema', () => {
  it('accepts valid base64 with default sample_rate', () => {
    const parsed = vadRequestSchema.parse({ audio_base64: validBase64 });
    expect(parsed.sample_rate).toBe(16_000);
  });

  it('accepts 8000 Hz sample_rate', () => {
    const parsed = vadRequestSchema.parse({ audio_base64: validBase64, sample_rate: 8_000 });
    expect(parsed.sample_rate).toBe(8_000);
  });

  it('rejects too-short audio_base64', () => {
    expect(() => vadRequestSchema.parse({ audio_base64: 'aa' })).toThrow();
  });

  it('rejects audio_base64 exceeding size limit', () => {
    const oversize = 'A'.repeat(VAD_MAX_AUDIO_BASE64_CHARS + 1);
    expect(() => vadRequestSchema.parse({ audio_base64: oversize })).toThrow();
  });

  it('rejects non-base64 characters', () => {
    expect(() => vadRequestSchema.parse({ audio_base64: '!!!invalid!!!' })).toThrow();
  });

  it('rejects unsupported sample_rate', () => {
    expect(() =>
      vadRequestSchema.parse({ audio_base64: validBase64, sample_rate: 44_100 }),
    ).toThrow();
  });

  it('rejects extra fields under strict mode', () => {
    expect(() => vadRequestSchema.parse({ audio_base64: validBase64, leak: 'field' })).toThrow();
  });
});

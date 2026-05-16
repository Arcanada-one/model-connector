import { describe, it, expect } from 'vitest';
import {
  assemblyAiTranscriptResponseSchema,
  assemblyAiUploadResponseSchema,
} from './assemblyai.schema';

describe('assemblyAiTranscriptResponseSchema', () => {
  const valid = {
    id: '7c0e8e88-aa83-4f1a-8a5e-1bb',
    status: 'completed' as const,
    text: 'The quick brown fox jumps over the lazy dog',
    audio_duration: 13,
    language_code: 'en',
    confidence: 0.94,
  };

  it('accepts a fully populated completed envelope', () => {
    const parsed = assemblyAiTranscriptResponseSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.text).toContain('quick brown fox');
  });

  it('tolerates absent optional `audio_duration` and `language_code`', () => {
    const minimal = { id: valid.id, status: 'completed' as const, text: 'short' };
    const parsed = assemblyAiTranscriptResponseSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
  });

  it('rejects status="processing" (only completed envelopes pass schema)', () => {
    const inFlight = { ...valid, status: 'processing' };
    const parsed = assemblyAiTranscriptResponseSchema.safeParse(inFlight);
    expect(parsed.success).toBe(false);
  });

  it('rejects missing required `text` field', () => {
    const { text: _text, ...rest } = valid;
    const parsed = assemblyAiTranscriptResponseSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });
});

describe('assemblyAiUploadResponseSchema', () => {
  it('accepts a valid upload_url', () => {
    const parsed = assemblyAiUploadResponseSchema.safeParse({
      upload_url: 'https://cdn.assemblyai.com/upload/abc-123',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects non-URL upload_url', () => {
    const parsed = assemblyAiUploadResponseSchema.safeParse({ upload_url: 'not-a-url' });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing upload_url', () => {
    const parsed = assemblyAiUploadResponseSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

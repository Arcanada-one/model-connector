import { describe, it, expect } from 'vitest';
import { deepgramListenResponseSchema } from './deepgram.schema';

describe('deepgramListenResponseSchema', () => {
  const valid = {
    metadata: {
      request_id: 'req-abc-1',
      duration: 13.7,
      sha256: 'deadbeef',
    },
    results: {
      channels: [
        {
          alternatives: [{ transcript: 'The quick brown fox', confidence: 0.99 }],
        },
      ],
    },
  };

  it('accepts a fully populated nova-3 response', () => {
    const parsed = deepgramListenResponseSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.results.channels[0].alternatives[0].transcript).toBe('The quick brown fox');
    expect(parsed.data.metadata.request_id).toBe('req-abc-1');
  });

  it('tolerates absent optional `metadata.duration`', () => {
    const { metadata, ...rest } = valid;
    const partial = { ...rest, metadata: { request_id: metadata.request_id } };
    const parsed = deepgramListenResponseSchema.safeParse(partial);
    expect(parsed.success).toBe(true);
  });

  it('tolerates extra top-level keys (passthrough)', () => {
    const withExtra = { ...valid, telemetry: { provider_version: '2026-05' } };
    const parsed = deepgramListenResponseSchema.safeParse(withExtra);
    expect(parsed.success).toBe(true);
  });

  it('rejects missing `results.channels[0].alternatives[0].transcript`', () => {
    const broken = {
      metadata: { request_id: 'req-1' },
      results: { channels: [{ alternatives: [{}] }] },
    };
    const parsed = deepgramListenResponseSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
  });

  it('rejects empty channels array', () => {
    const broken = { metadata: { request_id: 'req-1' }, results: { channels: [] } };
    const parsed = deepgramListenResponseSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
  });

  it('rejects missing `metadata.request_id`', () => {
    const broken = {
      metadata: {},
      results: { channels: [{ alternatives: [{ transcript: 'hi' }] }] },
    };
    const parsed = deepgramListenResponseSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
  });
});

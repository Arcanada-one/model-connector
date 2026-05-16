import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepgramSttConnector } from './deepgram-stt.connector';
import { validateEnv } from '../../config/env.schema';
import { SttProviderError } from './stt-pilot.errors';
import type { SttConnectorRequest } from './interfaces/stt-connector.interface';

function makeReq(overrides: Partial<SttConnectorRequest> = {}): SttConnectorRequest {
  const buf = Buffer.from('RIFFWAVEfmt placeholder');
  return {
    file: buf,
    filename: 'audio.wav',
    mimeType: 'audio/wav',
    audioBytes: buf.length,
    requestId: 'req-dg-spec-1',
    ...overrides,
  };
}

describe('DeepgramSttConnector', () => {
  let connector: DeepgramSttConnector;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_DEEPGRAM_API_KEY: 'dg_test_key',
      STT_DEEPGRAM_MODEL: 'nova-3',
      STT_DEEPGRAM_PRICE_USD_PER_MIN: '0.0043',
      STT_DEEPGRAM_TIMEOUT_MS: '60000',
    });
    connector = new DeepgramSttConnector();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends raw bytes with Token auth header and nova-3 model in query string', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          metadata: { request_id: 'req-1', duration: 1 },
          results: { channels: [{ alternatives: [{ transcript: 'hello' }] }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const result = await connector.transcribe(makeReq({ language: 'en' }));
    expect(result.transcription).toBe('hello');
    expect(result.model).toBe('nova-3');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('https://api.deepgram.com/v1/listen?model=nova-3');
    expect(String(url)).toContain('language=en');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Token dg_test_key');
    expect(headers['Content-Type']).toBe('audio/wav');
  });

  it('classifies HTTP 401 as auth_failed (SttProviderError)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ err_code: 'INVALID_AUTH' }), { status: 401 }),
    );
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      name: 'SttProviderError',
      type: 'auth_failed',
    });
  });

  it('classifies HTTP 500 as server_error', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      name: 'SttProviderError',
      type: 'server_error',
    });
  });

  it('treats malformed JSON as parse_error', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(connector.transcribe(makeReq())).rejects.toBeInstanceOf(SttProviderError);
  });

  it('computes cost from audio duration when nova-3 returns metadata.duration', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          metadata: { request_id: 'req-2', duration: 60 },
          results: { channels: [{ alternatives: [{ transcript: 'minute long' }] }] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const result = await connector.transcribe(makeReq());
    // 60 seconds → 1 minute × $0.0043 = $0.0043
    expect(result.costUsd).toBeCloseTo(0.0043);
  });
});

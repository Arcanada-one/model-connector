import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroqSttConnector } from './groq-stt.connector';
import { validateEnv } from '../../config/env.schema';
import type { SttConnectorRequest } from './interfaces/stt-connector.interface';

function makeReq(overrides: Partial<SttConnectorRequest> = {}): SttConnectorRequest {
  const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00]); // mp3-ish header bytes
  return {
    file: buf,
    filename: 'sample.wav',
    mimeType: 'audio/wav',
    audioBytes: buf.length,
    requestId: 'req-stt-1',
    ...overrides,
  };
}

describe('GroqSttConnector', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let connector: GroqSttConnector;

  beforeEach(() => {
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_GROQ_API_KEY: 'gsk_test_specific_key',
      STT_GROQ_PRICE_USD_PER_MIN: '0.00185',
      STT_GROQ_MODEL: 'whisper-large-v3',
    });
    connector = new GroqSttConnector();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.STT_GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  it('targets api.groq.com /openai/v1/audio/transcriptions with Bearer auth', async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ text: 'hi', duration: 1.0, language: 'English' }), {
          status: 200,
        }),
    );
    await connector.transcribe(makeReq());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer gsk_test_specific_key');
    // FormData→fetch encodes its own boundary; we MUST NOT pre-set Content-Type.
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('sends multipart with model + response_format=verbose_json defaults', async () => {
    fetchSpy.mockImplementationOnce(
      async () => new Response(JSON.stringify({ text: 'hi', duration: 1.0 }), { status: 200 }),
    );
    await connector.transcribe(makeReq({ language: 'en', prompt: 'medical' }));
    const fd = (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(fd.get('model')).toBe('whisper-large-v3');
    expect(fd.get('response_format')).toBe('verbose_json');
    expect(fd.get('language')).toBe('en');
    expect(fd.get('prompt')).toBe('medical');
    expect(fd.get('file')).toBeInstanceOf(Blob);
  });

  it('omits optional fields when not provided', async () => {
    fetchSpy.mockImplementationOnce(
      async () => new Response(JSON.stringify({ text: 'hi', duration: 0.5 }), { status: 200 }),
    );
    await connector.transcribe(makeReq());
    const fd = (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(fd.get('language')).toBeNull();
    expect(fd.get('prompt')).toBeNull();
    expect(fd.get('temperature')).toBeNull();
  });

  it('parses verbose_json: trims text, copies duration, maps language', async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            text: '  The quick brown fox.  ',
            duration: 2.42,
            language: 'English',
            x_groq: { id: 'req_xyz' },
          }),
          { status: 200 },
        ),
    );
    const r = await connector.transcribe(makeReq());
    expect(r.transcription).toBe('The quick brown fox.');
    expect(r.audioDurationSeconds).toBe(2.42);
    expect(r.detectedLanguage).toBe('en');
    expect(r.providerRequestId).toBe('req_xyz');
    expect(r.model).toBe('whisper-large-v3');
  });

  it('computes cost from duration × pricePerMin', async () => {
    fetchSpy.mockImplementationOnce(
      async () => new Response(JSON.stringify({ text: 'hi', duration: 60.0 }), { status: 200 }),
    );
    const r = await connector.transcribe(makeReq());
    // 60 seconds = 1 minute × 0.00185 USD
    expect(r.costUsd).toBeCloseTo(0.00185, 8);
  });

  it('maps 401 to SttProviderError(auth_failed) with upstream code', async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'invalid_api_key', message: 'Invalid API Key' },
          }),
          { status: 401 },
        ),
    );
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      name: 'SttProviderError',
      provider: 'groq',
      type: 'auth_failed',
      upstreamCode: 'invalid_api_key',
      upstreamStatus: 401,
    });
  });

  it('maps 413 to SttProviderError(http_error) with upstream code request_too_large', async () => {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: { code: 'request_too_large' } }), { status: 413 }),
    );
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      name: 'SttProviderError',
      type: 'http_error',
      upstreamCode: 'request_too_large',
      upstreamStatus: 413,
    });
  });

  it('falls back to GROQ_API_KEY when STT_GROQ_API_KEY is not set', async () => {
    // Reset env to a state without STT_GROQ_API_KEY.
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      // STT_GROQ_API_KEY intentionally omitted
    });
    process.env.GROQ_API_KEY = 'gsk_legacy_chat_key';
    const fresh = new GroqSttConnector();
    fetchSpy.mockImplementationOnce(
      async () => new Response(JSON.stringify({ text: 'x', duration: 0.1 }), { status: 200 }),
    );
    await fresh.transcribe(makeReq());
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer gsk_legacy_chat_key');
  });

  it('uses request.model when supplied (overrides STT_GROQ_MODEL)', async () => {
    fetchSpy.mockImplementationOnce(
      async () => new Response(JSON.stringify({ text: 'x', duration: 0.1 }), { status: 200 }),
    );
    await connector.transcribe(makeReq({ model: 'whisper-large-v3-turbo' }));
    const fd = (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(fd.get('model')).toBe('whisper-large-v3-turbo');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiSttConnector } from './openai-stt.connector';
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
    requestId: 'req-oai-spec-1',
    ...overrides,
  };
}

describe('OpenAiSttConnector', () => {
  let connector: OpenAiSttConnector;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_OPENAI_API_KEY: 'sk-test-key',
      STT_OPENAI_MODEL: 'gpt-4o-mini-transcribe',
      STT_OPENAI_PRICE_USD_PER_MIN: '0.006',
    });
    connector = new OpenAiSttConnector();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends multipart with Bearer auth and response_format=json (not verbose_json)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'live capture' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const result = await connector.transcribe(makeReq());
    expect(result.transcription).toBe('live capture');
    expect(result.model).toBe('gpt-4o-mini-transcribe');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test-key' });
    const body = (init as RequestInit).body as FormData;
    expect(body.get('response_format')).toBe('json');
    expect(body.get('model')).toBe('gpt-4o-mini-transcribe');
  });

  it('passes language through when supplied (OpenAI does not echo it)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'hello' }), { status: 200 }),
    );
    const result = await connector.transcribe(makeReq({ language: 'en' }));
    expect(result.detectedLanguage).toBe('en');
  });

  it('classifies HTTP 401 as auth_failed', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), { status: 401 }),
    );
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      name: 'SttProviderError',
      type: 'auth_failed',
    });
  });

  it('classifies HTTP 429 as rate_limited', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    await expect(connector.transcribe(makeReq())).rejects.toMatchObject({
      type: 'rate_limited',
    });
  });

  it('treats malformed JSON as SttProviderError', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(connector.transcribe(makeReq())).rejects.toBeInstanceOf(SttProviderError);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '../../config/env.schema';
import { UnknownDeepgramAuraModelError } from './deepgram-aura-models';
import { DeepgramTtsConnector, DeepgramTtsError } from './deepgram-tts.connector';

const baseEnv = {
  DATABASE_URL: 'postgresql://test',
  STT_GROQ_API_KEY: 'test-groq-key',
  TTS_PROVIDER_DEEPGRAM_ENABLED: 'true',
  TTS_DEEPGRAM_API_KEY: 'test-deepgram-key',
  TTS_DEEPGRAM_BASE_URL: 'https://api.deepgram.com',
  TTS_DEEPGRAM_TIMEOUT_MS: '30000',
};

describe('DeepgramTtsConnector', () => {
  let connector: DeepgramTtsConnector;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    validateEnv(baseEnv);
    connector = new DeepgramTtsConnector();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails closed without sending a request when the provider is disabled', async () => {
    validateEnv({ ...baseEnv, TTS_PROVIDER_DEEPGRAM_ENABLED: 'false' });

    await expect(
      connector.synthesize('aura-asteria-en', 'hello', { requestId: 'req-disabled' }),
    ).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'provider_disabled',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts once with exact model, output, auth, body, and request ID', async () => {
    const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    fetchSpy.mockResolvedValueOnce(
      new Response(audio, {
        status: 200,
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Length': String(audio.length),
          'X-Request-ID': 'provider-request-id',
          'X-Unsafe-Provider-Header': 'must-not-pass',
        },
      }),
    );

    const result = await connector.synthesize('aura-asteria-en', 'hello', {
      requestId: 'req-success',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [rawUrl, init] = fetchSpy.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(`${url.origin}${url.pathname}`).toBe('https://api.deepgram.com/v1/speak');
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      model: 'aura-asteria-en',
      encoding: 'linear16',
      container: 'wav',
      sample_rate: '24000',
    });
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    });
    expect((init?.headers as Record<string, string>).Authorization).toBe('Token test-deepgram-key');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init?.headers as Record<string, string>)['X-Request-ID']).toBe('req-success');
    expect(result.status).toBe(200);
    expect(Array.from(new Uint8Array(result.body))).toEqual(Array.from(audio));
    expect(result.contentType).toBe('audio/wav');
    expect(result.headers).toEqual({
      'content-type': 'audio/wav',
      'content-length': '4',
      'x-request-id': 'provider-request-id',
    });
  });

  it('selects the exact Luna model through the shared transport', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(new Uint8Array([0x52]), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      }),
    );

    await connector.synthesize('aura-luna-en', 'hello from Luna', {
      requestId: 'req-luna',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.searchParams.get('model')).toBe('aura-luna-en');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('container')).toBe('wav');
    expect(url.searchParams.get('sample_rate')).toBe('24000');
  });

  it('selects the exact Stella model through the shared transport', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(new Uint8Array([0x52]), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      }),
    );

    await connector.synthesize('aura-stella-en', 'hello from Stella', {
      requestId: 'req-stella',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.searchParams.get('model')).toBe('aura-stella-en');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('container')).toBe('wav');
    expect(url.searchParams.get('sample_rate')).toBe('24000');
  });

  it('fails closed before fetch for an unregistered runtime model', async () => {
    await expect(
      connector.synthesize('unreviewed-model' as never, 'hello', {
        requestId: 'req-unknown',
      }),
    ).rejects.toBeInstanceOf(UnknownDeepgramAuraModelError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [429, 429, 'upstream_rate_limited'],
    [401, 502, 'upstream_authentication_failed'],
    [403, 502, 'upstream_authentication_failed'],
    [500, 502, 'upstream_unavailable'],
  ])('maps upstream %i without reading its body', async (upstream, statusCode, errorCode) => {
    const response = new Response('sensitive-provider-detail', { status: upstream });
    const textSpy = vi.spyOn(response, 'text');
    const arrayBufferSpy = vi.spyOn(response, 'arrayBuffer');
    fetchSpy.mockResolvedValueOnce(response);

    await expect(
      connector.synthesize('aura-asteria-en', 'hello', { requestId: 'req-error' }),
    ).rejects.toMatchObject({ statusCode, errorCode, upstreamStatus: upstream });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(textSpy).not.toHaveBeenCalled();
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('rejects a successful non-audio response without reading its body', async () => {
    const response = new Response('unexpected-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const textSpy = vi.spyOn(response, 'text');
    const arrayBufferSpy = vi.spyOn(response, 'arrayBuffer');
    fetchSpy.mockResolvedValueOnce(response);

    await expect(
      connector.synthesize('aura-asteria-en', 'hello', {
        requestId: 'req-wrong-media',
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      errorCode: 'upstream_unavailable',
    });
    expect(textSpy).not.toHaveBeenCalled();
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty audio response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(new Uint8Array(), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      }),
    );

    await expect(
      connector.synthesize('aura-asteria-en', 'hello', { requestId: 'req-empty-audio' }),
    ).rejects.toMatchObject({
      statusCode: 502,
      errorCode: 'upstream_unavailable',
    });
  });

  it('maps a timeout to a sanitized 504 error', async () => {
    fetchSpy.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

    await expect(
      connector.synthesize('aura-asteria-en', 'hello', { requestId: 'req-timeout' }),
    ).rejects.toMatchObject({
      statusCode: 504,
      errorCode: 'upstream_timeout',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('maps a network failure without leaking its original message', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('host contained a private diagnostic'));

    const error = await connector
      .synthesize('aura-asteria-en', 'hello', { requestId: 'req-network' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeepgramTtsError);
    expect(error).toMatchObject({
      statusCode: 502,
      errorCode: 'upstream_unavailable',
    });
    expect((error as Error).message).not.toContain('private diagnostic');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

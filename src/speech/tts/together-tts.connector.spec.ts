import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEnv } from '../../config/env.schema';
import { TogetherTtsConnector, TogetherTtsError } from './together-tts.connector';

function setConfig(overrides: Record<string, string> = {}): void {
  validateEnv({
    DATABASE_URL: 'postgresql://test',
    STT_GROQ_API_KEY: 'placeholder',
    TTS_PROVIDER_TOGETHER_ENABLED: 'true',
    TOGETHER_API_KEY: 'placeholder',
    ...overrides,
  });
}

function makeErrorResponse(status: number) {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const arrayBuffer = vi.fn();
  const text = vi.fn();
  const json = vi.fn();
  const response = {
    ok: false,
    status,
    headers: new Headers(),
    body: { cancel },
    arrayBuffer,
    text,
    json,
  } as unknown as Response;
  return { response, cancel, arrayBuffer, text, json };
}

const orpheusRequest = {
  provider: 'together',
  model: 'canopylabs/orpheus-3b-0.1-ft',
  text: 'Hello',
  voice: 'tara',
} as const;

const cartesiaRequest = {
  provider: 'together',
  model: 'cartesia/sonic-2',
  text: 'Hello',
  voice: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
} as const;

describe('TogetherTtsConnector', () => {
  let connector: TogetherTtsConnector;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setConfig();
    connector = new TogetherTtsConnector();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts the exact model and closed voice to the current Together endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer, {
        status: 200,
        headers: { 'Content-Type': 'audio/wav', 'X-Request-ID': 'upstream-fixture' },
      }),
    );

    const result = await connector.synthesize(orpheusRequest, { requestId: 'req-0311' });

    expect(result.status).toBe(200);
    expect(result.contentType).toBe('audio/wav');
    expect(new Uint8Array(result.body)).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.together.ai/v1/audio/speech');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer placeholder',
        'Content-Type': 'application/json',
        'X-Request-ID': 'req-0311',
      },
    });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      model: 'canopylabs/orpheus-3b-0.1-ft',
      input: 'Hello',
      voice: 'tara',
      response_format: 'wav',
    });
  });

  it('posts the exact Cartesia model and UUID voice through the shared transport', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer, {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      }),
    );

    await connector.synthesize(cartesiaRequest, { requestId: 'req-0312' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('https://api.together.ai/v1/audio/speech');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      model: 'cartesia/sonic-2',
      input: 'Hello',
      voice: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
      response_format: 'wav',
    });
  });

  it('fails closed without calling fetch when the provider is disabled', async () => {
    setConfig({ TTS_PROVIDER_TOGETHER_ENABLED: 'false' });

    await expect(
      connector.synthesize(cartesiaRequest, { requestId: 'req-disabled' }),
    ).rejects.toEqual(
      expect.objectContaining({
        errorCode: 'provider_disabled',
        statusCode: 503,
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'upstream_authentication_failed', 502],
    [403, 'upstream_authentication_failed', 502],
    [429, 'upstream_rate_limited', 429],
    [400, 'upstream_unavailable', 502],
    [500, 'upstream_unavailable', 502],
  ])('maps HTTP %i without consuming provider details', async (status, errorCode, statusCode) => {
    const fake = makeErrorResponse(status);
    fetchSpy.mockResolvedValueOnce(fake.response);

    await expect(connector.synthesize(cartesiaRequest, { requestId: 'req-error' })).rejects.toEqual(
      expect.objectContaining({ errorCode, statusCode, upstreamStatus: status }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    expect(fake.arrayBuffer).not.toHaveBeenCalled();
    expect(fake.text).not.toHaveBeenCalled();
    expect(fake.json).not.toHaveBeenCalled();
  });

  it('maps timeouts separately from other network failures', async () => {
    fetchSpy.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(
      connector.synthesize(cartesiaRequest, { requestId: 'req-timeout' }),
    ).rejects.toEqual(expect.objectContaining({ errorCode: 'upstream_timeout', statusCode: 504 }));

    fetchSpy.mockRejectedValueOnce(new Error('network fixture'));
    await expect(
      connector.synthesize(cartesiaRequest, { requestId: 'req-network' }),
    ).rejects.toEqual(
      expect.objectContaining({ errorCode: 'upstream_unavailable', statusCode: 502 }),
    );
  });

  it.each([
    ['application/json', new Uint8Array([1]).buffer],
    ['audio/wav', new ArrayBuffer(0)],
  ])('rejects invalid successful response %s', async (contentType, body) => {
    fetchSpy.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'Content-Type': contentType } }),
    );

    await expect(
      connector.synthesize(cartesiaRequest, { requestId: 'req-invalid' }),
    ).rejects.toBeInstanceOf(TogetherTtsError);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DeepgramAuraHttpClient, DeepgramTtsHttpError } from './deepgram-tts.http';

describe('DeepgramAuraHttpClient', () => {
  it.each([
    ['api-key', 'Token secret-key'],
    ['bearer', 'Bearer temporary-jwt'],
  ] as const)(
    'synthesizes with %s authentication and preserves binary metadata',
    async (authType, expected) => {
      const fetch = vi.fn().mockResolvedValue(
        new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'dg-request-id': 'request-1' },
        }),
      );
      const client = new DeepgramAuraHttpClient({ fetch });

      const result = await client.synthesize({
        text: 'Hello Aura',
        model: 'aura-2-thalia-en',
        encoding: 'mp3',
        sampleRate: 24_000,
        baseUrl: 'https://api.eu.deepgram.com',
        auth:
          authType === 'api-key'
            ? { type: authType, credential: 'secret-key' }
            : { type: authType, credential: 'temporary-jwt' },
      });

      const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://api.eu.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&sample_rate=24000',
      );
      expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ text: 'Hello Aura' }) });
      expect(init.headers).toMatchObject({
        Authorization: expected,
        'Content-Type': 'application/json',
      });
      expect([...result.audio]).toEqual([1, 2, 3]);
      expect(result.contentType).toBe('audio/mpeg');
      expect(result.requestId).toBe('request-1');
    },
  );

  it('encodes query values rather than interpolating them', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array(), { status: 200 }));
    const client = new DeepgramAuraHttpClient({ fetch });
    await client.synthesize({
      text: 'x',
      model: 'voice & model',
      auth: { type: 'api-key', credential: 'k' },
    });
    expect(fetch.mock.calls[0][0]).toContain('model=voice+%26+model');
  });

  it.each([
    [401, JSON.stringify({ err_code: 'INVALID_AUTH', err_msg: 'bad key' }), 'INVALID_AUTH'],
    [429, 'rate limited', undefined],
  ])('preserves safe upstream error detail for HTTP %i', async (status, body, code) => {
    const fetch = vi.fn().mockResolvedValue(new Response(body, { status }));
    const client = new DeepgramAuraHttpClient({ fetch });
    const promise = client.synthesize({
      text: 'x',
      model: 'aura-2-thalia-en',
      auth: { type: 'api-key', credential: 'never-expose-me' },
    });
    await expect(promise).rejects.toMatchObject({ status, code, body });
    await expect(promise).rejects.not.toThrow(/never-expose-me/);
    await expect(promise).rejects.toBeInstanceOf(DeepgramTtsHttpError);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  ADOBE_FIREFLY_NATIVE_API,
  AdobeFireflyConnector,
  AdobeFireflyError,
} from './adobe-firefly.connector';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('AdobeFireflyConnector', () => {
  it('submits documented async operations with Adobe auth headers', async () => {
    const transport = vi.fn(async () =>
      jsonResponse({ jobId: 'urn:ff:jobs:1', statusUrl: 'https://firefly-api.adobe.io/v3/status/urn:ff:jobs:1', cancelUrl: 'https://firefly-api.adobe.io/v3/cancel/urn:ff:jobs:1' }, 202),
    );
    const client = new AdobeFireflyConnector('client-id', 'access-token', transport);

    await client.submit('generate', { prompt: 'a red fox' }, 'image4_standard');

    expect(transport).toHaveBeenCalledWith(
      'https://firefly-api.adobe.io/v3/images/generate-async',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ prompt: 'a red fox' }),
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer access-token',
          'Content-Type': 'application/json',
          'x-api-key': 'client-id',
          'x-model-version': 'image4_standard',
        }),
      }),
    );
  });

  it.each([
    ['generate', '/v3/images/generate-async'],
    ['expand', '/v3/images/expand-async'],
    ['fill', '/v3/images/fill-async'],
    ['composite', '/v3/images/generate-object-composite-async'],
    ['similar', '/v3/images/generate-similar-async'],
  ] as const)('maps %s only to its documented async endpoint', async (operation, path) => {
    const submission = { jobId: 'job', statusUrl: 'status', cancelUrl: 'cancel' };
    const transport = vi.fn(async () => jsonResponse(submission, 202));
    const client = new AdobeFireflyConnector('id', 'token', transport);
    await expect(client.submit(operation, { prompt: 'test' })).resolves.toEqual(submission);
    expect(transport.mock.calls[0]?.[0]).toBe(`https://firefly-api.adobe.io${path}`);
  });

  it('gets status and cancels by encoded job id without following response URLs', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'running', jobId: 'urn:ff:jobs:1' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'cancelled', jobId: 'urn:ff:jobs:1' }));
    const client = new AdobeFireflyConnector('id', 'token', transport);

    await expect(client.getStatus('urn:ff:jobs:1')).resolves.toMatchObject({ status: 'running' });
    await client.cancel('urn:ff:jobs:1');

    expect(String(transport.mock.calls[0]?.[0]).endsWith('/v3/status/urn%3Aff%3Ajobs%3A1')).toBe(
      true,
    );
    expect(transport.mock.calls[1]).toEqual([
      expect.stringMatching(/\/v3\/cancel\/urn%3Aff%3Ajobs%3A1$/),
      expect.objectContaining({ method: 'PUT' }),
    ]);
    for (const call of transport.mock.calls) {
      expect(call[1]?.headers).toMatchObject({
        Accept: 'application/json',
        Authorization: 'Bearer token',
        'x-api-key': 'id',
      });
    }
  });

  it('uploads an image asset with its media type and returns Adobe upload ids', async () => {
    const transport = vi.fn(async () => jsonResponse({ images: [{ id: 'upload-1' }] }, 201));
    const client = new AdobeFireflyConnector('id', 'token', transport);
    await expect(client.uploadImage(new Uint8Array([1, 2]), 'image/png')).resolves.toEqual({ images: [{ id: 'upload-1' }] });
    expect(transport).toHaveBeenCalledWith(
      'https://firefly-api.adobe.io/v2/storage/image',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(Uint8Array),
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer token',
          'Content-Type': 'image/png',
          'x-api-key': 'id',
        }),
      }),
    );
  });

  it('surfaces documented HTTP failures without leaking credentials', async () => {
    const transport = vi.fn(async () =>
      jsonResponse(
        {
          error_code: 'rate_limit',
          message: 'slow down for secret-client with secret-token',
        },
        429,
      ),
    );
    const client = new AdobeFireflyConnector('secret-client', 'secret-token', transport);
    const error = await client.getStatus('job').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdobeFireflyError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limit' });
    expect(String(error)).toContain('slow down');
    expect(String(error)).toContain('[redacted]');
    expect(String(error)).not.toContain('secret-client');
    expect(String(error)).not.toContain('secret-token');
  });

  it('rejects missing credentials before transport', async () => {
    const transport = vi.fn();
    const client = new AdobeFireflyConnector('', '', transport);
    await expect(client.submit('generate', { prompt: 'test' })).rejects.toThrow(/not provisioned/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [
      'generateImage5',
      '/v4/images/generate-async',
      {
        links: {
          result: { href: 'https://firefly-api.adobe.io/v3/status/job-image5' },
          cancel: { href: 'https://firefly-api.adobe.io/v3/cancel/job-image5' },
        },
        progress: 0,
      },
    ],
    [
      'preciseComposite',
      '/v3/images/precise-composite',
      { status: 'running', jobId: 'job-precise', statusUrl: 'status', cancelUrl: 'cancel' },
    ],
    [
      'adaptiveComposite',
      '/v3/images/adaptive-composite',
      { status: 'running', jobId: 'job-adaptive', statusUrl: 'status', cancelUrl: 'cancel' },
    ],
    [
      'upscale',
      '/v3/images/upscale',
      {
        links: {
          result: { href: 'https://firefly-api.adobe.io/v3/status/job-upscale' },
          cancel: { href: 'https://firefly-api.adobe.io/v3/cancel/job-upscale' },
        },
      },
    ],
  ] as const)(
    'maps current %s to its documented endpoint and preserves its envelope',
    async (operation, path, submission) => {
      const transport = vi.fn(async () => jsonResponse(submission, 202));
      const client = new AdobeFireflyConnector('id', 'token', transport);
      await expect(client.submit(operation, {})).resolves.toEqual(submission);
      expect(transport.mock.calls[0]?.[0]).toBe(`https://firefly-api.adobe.io${path}`);
    },
  );

  it('keeps Image5 and precise-upscale model headers distinct', async () => {
    const transport = vi.fn(async () => jsonResponse({ links: {}, progress: 0 }));
    const client = new AdobeFireflyConnector('id', 'token', transport);

    await expect(client.submit('generateImage5', { prompt: 'test' })).resolves.toMatchObject({
      progress: 0,
    });
    await client.submit('upscale', { image: { source: { uploadId: 'upload-1' } } });

    expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-model-version': 'image5',
    });
    expect(transport.mock.calls[1]?.[1]?.headers).toMatchObject({
      'x-model-version': 'precise_upsampler_v1',
    });
  });

  it('rejects unsupported model headers before transport', async () => {
    const transport = vi.fn();
    const client = new AdobeFireflyConnector('id', 'token', transport);

    await expect(client.submit('fill', {}, 'image3')).rejects.toThrow(/model header/i);
    await expect(client.submit('similar', {}, 'image4_custom')).rejects.toThrow(/not supported/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('preserves failed status payloads and accepts an empty cancel response', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', jobId: 'job-1' }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new AdobeFireflyConnector('id', 'token', transport);

    await expect(client.getStatus('job-1')).resolves.toEqual({ status: 'failed', jobId: 'job-1' });
    await expect(client.cancel('job-1')).resolves.toBeUndefined();
  });

  it('preserves a succeeded status result without normalization', async () => {
    const succeeded = {
      status: 'succeeded',
      jobId: 'job-1',
      result: { outputs: [{ seed: 333, image: { url: 'https://example.com/image.png' } }] },
    } as const;
    const transport = vi.fn(async () => jsonResponse(succeeded));
    const client = new AdobeFireflyConnector('id', 'token', transport);

    await expect(client.getStatus('job-1')).resolves.toEqual(succeeded);
  });

  it('accepts a non-JSON successful cancellation without inventing data', async () => {
    const transport = vi.fn(async () =>
      new Response('cancel accepted', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const client = new AdobeFireflyConnector('id', 'token', transport);

    await expect(client.cancel('job-1')).resolves.toBeUndefined();
  });

  it('uploads every media type documented by the native storage API', async () => {
    const transport = vi.fn(async () => jsonResponse({ images: [{ id: 'upload-1' }] }));
    const client = new AdobeFireflyConnector('id', 'token', transport);

    for (const mediaType of [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/tiff',
      'image/jxl',
    ] as const) {
      await client.uploadImage(new Uint8Array([1]), mediaType);
    }

    expect(transport.mock.calls.map((call) => call[1]?.headers)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ 'Content-Type': 'image/webp' }),
        expect.objectContaining({ 'Content-Type': 'image/tiff' }),
        expect.objectContaining({ 'Content-Type': 'image/jxl' }),
      ]),
    );
  });

  it('publishes only documented statuses and explicit non-claims', () => {
    expect(ADOBE_FIREFLY_NATIVE_API.jobStatuses).toEqual(['running', 'succeeded', 'failed']);
    expect(ADOBE_FIREFLY_NATIVE_API.models.generate).toEqual([
      'image3',
      'image3_custom',
      'image4_standard',
      'image4_ultra',
      'image4_custom',
    ]);
    expect(ADOBE_FIREFLY_NATIVE_API.models.similar).toEqual([
      'image3',
      'image4_standard',
      'image4_ultra',
    ]);
    expect(ADOBE_FIREFLY_NATIVE_API.synchronousOperations).toBeNull();
    expect(ADOBE_FIREFLY_NATIVE_API.pagination).toBeNull();
    expect(ADOBE_FIREFLY_NATIVE_API.regionSelection).toBeNull();
    expect(ADOBE_FIREFLY_NATIVE_API.upload).toMatchObject({
      maxMegabytes: 15,
      validityDays: 7,
    });
  });
});

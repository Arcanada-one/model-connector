import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AzureAiContentSafetyConnector,
  AzureContentSafetyError,
  type AzureContentSafetyConfig,
  type AzureContentSafetyTransport,
  type ImageInspector,
} from './azure-ai-content-safety.connector';

const ENDPOINT = 'https://unit-resource.cognitiveservices.azure.com';
const API_KEY = 'api-key-fixture';
const PNG_50 =
  'iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAYAAAAeP4ixAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAIElEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAwKMBJ0IAAfymlf4AAAAASUVORK5CYII=';
const CATEGORIES = ['Hate', 'SelfHarm', 'Sexual', 'Violence'] as const;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')) as unknown;
}

describe('AzureAiContentSafetyConnector', () => {
  let transport: ReturnType<typeof vi.fn<AzureContentSafetyTransport>>;
  let inspectImage: ReturnType<typeof vi.fn<ImageInspector>>;
  let connector: AzureAiContentSafetyConnector;

  beforeEach(() => {
    transport = vi.fn<AzureContentSafetyTransport>();
    inspectImage = vi.fn<ImageInspector>().mockResolvedValue({
      format: 'png',
      width: 50,
      height: 50,
    });
    connector = new AzureAiContentSafetyConnector({
      endpoint: ENDPOINT,
      auth: { type: 'apiKey', value: API_KEY },
      transport,
      inspectImage,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function reply(name: string, status = 200, headers: Record<string, string> = {}): void {
    transport.mockResolvedValueOnce({
      status,
      headers,
      body: JSON.stringify(fixture(name)),
    });
  }

  it('builds the exact text URL, API-key header, and explicit default body', async () => {
    reply('text-four.json');
    await connector.analyzeText({ text: 'synthetic text' });

    expect(transport).toHaveBeenCalledWith(
      `${ENDPOINT}/contentsafety/text:analyze?api-version=2024-09-01`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': API_KEY,
        },
        body: JSON.stringify({
          text: 'synthetic text',
          categories: CATEGORIES,
          outputType: 'FourSeverityLevels',
        }),
      }),
    );
  });

  it('supports an injected bearer token without an API-key header', async () => {
    connector = new AzureAiContentSafetyConnector({
      endpoint: ENDPOINT,
      auth: { type: 'bearerToken', value: 'bearer-fixture' },
      transport,
      inspectImage,
    });
    reply('image-four.json');
    await connector.analyzeImage({ content: PNG_50 });

    const init = transport.mock.calls[0][1];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer bearer-fixture',
    });
    expect(init.headers).not.toHaveProperty('Ocp-Apim-Subscription-Key');
  });

  it('builds the exact image URL and base64-only body', async () => {
    reply('image-four.json');
    await connector.analyzeImage({ content: PNG_50 });

    expect(transport.mock.calls[0][0]).toBe(
      `${ENDPOINT}/contentsafety/image:analyze?api-version=2024-09-01`,
    );
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({
      image: { content: PNG_50 },
      categories: CATEGORIES,
      outputType: 'FourSeverityLevels',
    });
  });

  it('passes documented optional text fields and normalizes eight-level output', async () => {
    reply('text-eight.json');
    const result = await connector.analyzeText({
      text: 'synthetic text',
      categories: ['SelfHarm', 'Hate'],
      blocklistNames: ['synthetic-list'],
      haltOnBlocklistHit: false,
      outputType: 'EightSeverityLevels',
    });

    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({
      text: 'synthetic text',
      categories: ['SelfHarm', 'Hate'],
      blocklistNames: ['synthetic-list'],
      haltOnBlocklistHit: false,
      outputType: 'EightSeverityLevels',
    });
    expect(result).toEqual({
      outputType: 'EightSeverityLevels',
      categories: [
        { category: 'Hate', severity: 1 },
        { category: 'SelfHarm', severity: 3 },
      ],
      blocklistMatches: [
        { blocklistName: 'synthetic-list', blocklistItemId: 'synthetic-item' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('synthetic matched text');
  });

  it('reconstructs all requested categories in canonical order', async () => {
    reply('text-four.json');
    const result = await connector.analyzeText({ text: 'synthetic text' });
    expect(result.categories).toEqual([
      { category: 'Hate', severity: 0 },
      { category: 'SelfHarm', severity: 6 },
      { category: 'Sexual', severity: 4 },
      { category: 'Violence', severity: 2 },
    ]);
    expect(result.blocklistMatches).toEqual([]);
  });

  it.each([
    'http://unit-resource.cognitiveservices.azure.com',
    'https://unit-resource.cognitiveservices.azure.com:444',
    'https://unit-resource.cognitiveservices.azure.com/path',
    'https://unit-resource.cognitiveservices.azure.com?query=1',
    'https://user@unit-resource.cognitiveservices.azure.com',
    'https://127.0.0.1',
    'https://eastus.api.cognitive.microsoft.com',
    'https://unit-resource.cognitiveservices.azure.com.evil.test',
    'https://-invalid.cognitiveservices.azure.com',
  ])('rejects invalid endpoint %s', (endpoint) => {
    expect(
      () =>
        new AzureAiContentSafetyConnector({
          endpoint,
          auth: { type: 'apiKey', value: API_KEY },
          transport,
          inspectImage,
        }),
    ).toThrowError(AzureContentSafetyError);
  });

  it.each([
    undefined,
    { type: 'apiKey', value: '' },
    { type: 'bearerToken', value: ' '.repeat(2) },
    { type: 'apiKey', value: 'x'.repeat(8193) },
    { type: 'apiKey', value: API_KEY, bearerToken: 'also-present' },
  ])('rejects missing, empty, oversized, or ambiguous auth', (auth) => {
    const config = { endpoint: ENDPOINT, auth, transport, inspectImage } as unknown as AzureContentSafetyConfig;
    expect(() => new AzureAiContentSafetyConnector(config)).toThrowError(
      AzureContentSafetyError,
    );
  });

  it('counts Unicode code points rather than UTF-16 units', async () => {
    reply('text-four.json');
    await connector.analyzeText({ text: '😀'.repeat(10_000) });
    expect(transport).toHaveBeenCalledOnce();

    transport.mockClear();
    await expect(connector.analyzeText({ text: '😀'.repeat(10_001) })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { text: 'ok', categories: ['Unknown'] },
    { text: 'ok', categories: ['Hate', 'Hate'] },
    { text: 'ok', outputType: 'Unknown' },
    { text: 'ok', unknown: true },
    { text: 'ok', blocklistNames: ['x'.repeat(65)] },
  ])('rejects invalid or unknown text request fields before transport', async (input) => {
    await expect(connector.analyzeText(input)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects cyclic and prototype-bearing text inputs before transport', async () => {
    const cyclic: Record<string, unknown> = { text: 'ok' };
    cyclic.self = cyclic;
    await expect(connector.analyzeText(cyclic)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    inherited.text = 'ok';
    await expect(connector.analyzeText(inherited)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('accepts each documented image format and the 50/2048 boundaries', async () => {
    for (const format of ['jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp'] as const) {
      for (const dimension of [50, 2048]) {
        inspectImage.mockResolvedValueOnce({ format, width: dimension, height: dimension });
        reply('image-four.json');
        await connector.analyzeImage({ content: PNG_50 });
      }
    }
    expect(transport).toHaveBeenCalledTimes(12);
  });

  it.each([
    { format: 'svg', width: 50, height: 50 },
    { format: 'png', width: 49, height: 50 },
    { format: 'png', width: 50, height: 49 },
    { format: 'png', width: 2049, height: 50 },
    { format: 'png', width: 50, height: 2049 },
    { format: 'png', width: undefined, height: 50 },
  ])('rejects unsupported or out-of-range image metadata %#', async (metadata) => {
    inspectImage.mockResolvedValueOnce(metadata);
    await expect(connector.analyzeImage({ content: PNG_50 })).rejects.toMatchObject({
      code: 'invalid_image',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects blobUrl, image eight-level output, unknown fields, and malformed base64', async () => {
    const inputs: unknown[] = [
      { blobUrl: 'https://example.test/image.png' },
      { content: PNG_50, blobUrl: 'https://example.test/image.png' },
      { content: PNG_50, outputType: 'EightSeverityLevels' },
      { content: PNG_50, unknown: true },
      { content: 'not base64' },
      { content: '====' },
    ];
    for (const input of inputs) {
      await expect(connector.analyzeImage(input)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects decoded image content over 4 MiB before inspection or transport', async () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 1).toString('base64');
    await expect(connector.analyzeImage({ content: oversized })).rejects.toMatchObject({
      code: 'invalid_image',
    });
    expect(inspectImage).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses the default local inspector for the authored 50x50 PNG', async () => {
    connector = new AzureAiContentSafetyConnector({
      endpoint: ENDPOINT,
      auth: { type: 'apiKey', value: API_KEY },
      transport,
    });
    reply('image-four.json');
    await expect(connector.analyzeImage({ content: PNG_50 })).resolves.toMatchObject({
      outputType: 'FourSeverityLevels',
    });
  });

  it.each([
    { categoriesAnalysis: [{ category: 'Hate', severity: 0 }] },
    {
      categoriesAnalysis: [
        { category: 'Hate', severity: 0 },
        { category: 'Hate', severity: 2 },
        { category: 'SelfHarm', severity: 0 },
        { category: 'Sexual', severity: 0 },
        { category: 'Violence', severity: 0 },
      ],
    },
    {
      categoriesAnalysis: [
        { category: 'Hate', severity: 1 },
        { category: 'SelfHarm', severity: 0 },
        { category: 'Sexual', severity: 0 },
        { category: 'Violence', severity: 0 },
      ],
    },
    { categoriesAnalysis: 'not-an-array' },
    { categoriesAnalysis: [], extra: true },
  ])('fails closed on malformed success payload %#', async (body) => {
    transport.mockResolvedValueOnce({ status: 200, headers: {}, body: JSON.stringify(body) });
    await expect(connector.analyzeText({ text: 'synthetic text' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('fails closed on invalid JSON and oversized response text', async () => {
    transport.mockResolvedValueOnce({ status: 200, headers: {}, body: '{invalid' });
    await expect(connector.analyzeText({ text: 'synthetic text' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
    transport.mockResolvedValueOnce({ status: 200, headers: {}, body: 'x'.repeat(65_537) });
    await expect(connector.analyzeText({ text: 'synthetic text' })).rejects.toMatchObject({
      code: 'response_too_large',
    });
  });

  it('turns redirects and HTTP errors into bounded redacted failures', async () => {
    transport.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'https://evil.test', 'x-ms-error-code': 'Redirected' },
      body: JSON.stringify(fixture('error.json')),
    });
    const redirectError = await connector
      .analyzeText({ text: 'sensitive input' })
      .catch((error: unknown) => error);
    expect(redirectError).toMatchObject({ code: 'http_error', status: 302, retryable: false });
    expect(JSON.stringify(redirectError)).not.toContain('evil.test');

    reply('error.json', 429, { 'x-ms-error-code': 'TooManyRequests' });
    const httpError = await connector
      .analyzeText({ text: 'sensitive input' })
      .catch((error: unknown) => error);
    expect(httpError).toMatchObject({
      code: 'http_error',
      status: 429,
      providerCode: 'TooManyRequests',
      retryable: true,
    });
    const serialized = JSON.stringify(httpError);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('sensitive input');
    expect(serialized).not.toContain('synthetic provider message');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('normalizes timeout and transport exceptions without leaking their messages', async () => {
    transport.mockRejectedValueOnce(
      new Error(`timeout with ${API_KEY} and sensitive input and ${'x'.repeat(10_000)}`),
    );
    const error = await connector
      .analyzeText({ text: 'sensitive input' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'transport_error', retryable: true });
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain('sensitive input');
  });
});

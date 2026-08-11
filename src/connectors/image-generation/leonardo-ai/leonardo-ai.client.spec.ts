import { describe, expect, it, vi } from 'vitest';
import {
  LEONARDO_V1_BASE_URL,
  LEONARDO_V1_LIMITS,
  LeonardoAiClient,
  LeonardoApiError,
  type LeonardoTransport,
  type LeonardoTransportRequest,
  type LeonardoTransportResponse,
} from './index';
import {
  BASE_URL,
  COMPLETE_GENERATION_RESPONSE,
  COMPLETE_VARIATION_RESPONSE,
  CREATE_GENERATION_RESPONSE,
  DELETE_GENERATION_RESPONSE,
  DELETE_INIT_IMAGE_RESPONSE,
  EXPECTED_MULTIPART_BYTES,
  FAILED_GENERATION_RESPONSE,
  GENERATION_ID,
  GENERATION_REQUEST,
  IMAGE_ID,
  INIT_FILE_BYTES,
  INIT_IMAGE_ID,
  INIT_IMAGE_RESPONSE,
  INIT_UPLOAD_RESPONSE,
  MODEL_ID,
  MULTIPART_BOUNDARY,
  NO_BACKGROUND_RESPONSE,
  PENDING_GENERATION_RESPONSE,
  PENDING_VARIATION_RESPONSE,
  PLACEHOLDER_API_KEY,
  PLATFORM_MODELS_RESPONSE,
  PROVIDER_ERROR_RESPONSE,
  UNIVERSAL_UPSCALER_REQUEST,
  UNIVERSAL_UPSCALER_RESPONSE,
  UPSCALE_RESPONSE,
  VARIATION_ID,
} from './leonardo-ai.fixtures';

class RecordingTransport implements LeonardoTransport {
  readonly requests: LeonardoTransportRequest[] = [];

  constructor(private readonly responses: LeonardoTransportResponse[]) {}

  async request(input: LeonardoTransportRequest): Promise<LeonardoTransportResponse> {
    this.requests.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error(`Unexpected unqueued request: ${input.method} ${input.url}`);
    return response;
  }
}

const jsonResponse = (body: unknown, status = 200): LeonardoTransportResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body,
});

const createClient = (
  responses: LeonardoTransportResponse[],
  overrides: Partial<{
    sleep: (milliseconds: number) => Promise<void>;
    boundaryFactory: () => string;
  }> = {},
) => {
  const transport = new RecordingTransport(responses);
  const client = new LeonardoAiClient({
    apiKey: PLACEHOLDER_API_KEY,
    transport,
    sleep: overrides.sleep ?? (async () => undefined),
    boundaryFactory: overrides.boundaryFactory ?? (() => MULTIPART_BOUNDARY),
  });
  return { client, transport };
};

const apiHeaders = (json = false) => ({
  accept: 'application/json',
  authorization: `Bearer ${PLACEHOLDER_API_KEY}`,
  ...(json ? { 'content-type': 'application/json' } : {}),
});

describe('LeonardoAiClient v1 protocol', () => {
  it('creates a generation with exact auth, URL, casing, body, and job envelope', async () => {
    const { client, transport } = createClient([jsonResponse(CREATE_GENERATION_RESPONSE)]);

    await expect(client.createGeneration(GENERATION_REQUEST)).resolves.toEqual(
      CREATE_GENERATION_RESPONSE,
    );
    expect(transport.requests).toEqual([
      {
        url: `${BASE_URL}/generations`,
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify(GENERATION_REQUEST),
      },
    ]);
  });

  it('polls PENDING to COMPLETE using only caller-supplied timing', async () => {
    const sleep = vi.fn(async () => undefined);
    const { client, transport } = createClient(
      [jsonResponse(PENDING_GENERATION_RESPONSE), jsonResponse(COMPLETE_GENERATION_RESPONSE)],
      { sleep },
    );

    const result = await client.pollGeneration(GENERATION_ID, {
      maxAttempts: 2,
      intervalMs: 17,
    });

    expect(result).toEqual(COMPLETE_GENERATION_RESPONSE);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(17);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]).toEqual({
      url: `${BASE_URL}/generations/${GENERATION_ID}`,
      method: 'GET',
      headers: apiHeaders(),
    });
  });

  it('treats FAILED as a terminal provider state without relabeling it', async () => {
    const { client } = createClient([
      jsonResponse(PENDING_GENERATION_RESPONSE),
      jsonResponse(FAILED_GENERATION_RESPONSE),
    ]);

    await expect(
      client.pollGeneration(GENERATION_ID, { maxAttempts: 2, intervalMs: 0 }),
    ).resolves.toEqual(FAILED_GENERATION_RESPONSE);
  });

  it('throws a safe exhaustion error when caller attempt cap is reached', async () => {
    const { client } = createClient([jsonResponse(PENDING_GENERATION_RESPONSE)]);

    await expect(
      client.pollGeneration(GENERATION_ID, { maxAttempts: 1, intervalMs: 0 }),
    ).rejects.toThrow('polling exhausted after 1 attempt');
  });

  it('deletes a generation with DELETE and preserves the deletion envelope', async () => {
    const { client, transport } = createClient([jsonResponse(DELETE_GENERATION_RESPONSE)]);

    await expect(client.deleteGeneration(GENERATION_ID)).resolves.toEqual(
      DELETE_GENERATION_RESPONSE,
    );
    expect(transport.requests[0]).toEqual({
      url: `${BASE_URL}/generations/${GENERATION_ID}`,
      method: 'DELETE',
      headers: apiHeaders(),
    });
  });
});

describe('LeonardoAiClient init-image lifecycle', () => {
  it('creates an exact init-image upload ticket request', async () => {
    const { client, transport } = createClient([jsonResponse(INIT_UPLOAD_RESPONSE)]);

    await expect(client.createInitImageUpload({ extension: 'png' })).resolves.toEqual(
      INIT_UPLOAD_RESPONSE,
    );
    expect(transport.requests[0]).toEqual({
      url: `${BASE_URL}/init-image`,
      method: 'POST',
      headers: apiHeaders(true),
      body: JSON.stringify({ extension: 'png' }),
    });
  });

  it('uploads exact multipart bytes to S3 without Leonardo authorization', async () => {
    const { client, transport } = createClient([{ status: 204, headers: {}, body: undefined }]);

    await expect(
      client.uploadInitImageAsset(INIT_UPLOAD_RESPONSE.uploadInitImage, {
        bytes: INIT_FILE_BYTES,
        filename: 'init.png',
        mediaType: 'image/png',
      }),
    ).resolves.toBeUndefined();

    expect(transport.requests[0]).toEqual({
      url: INIT_UPLOAD_RESPONSE.uploadInitImage.url,
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` },
      body: EXPECTED_MULTIPART_BYTES,
    });
    expect(transport.requests[0].headers).not.toHaveProperty('authorization');
  });

  it('gets and deletes the init-image resource with exact paths', async () => {
    const { client, transport } = createClient([
      jsonResponse(INIT_IMAGE_RESPONSE),
      jsonResponse(DELETE_INIT_IMAGE_RESPONSE),
    ]);

    await expect(client.getInitImage(INIT_IMAGE_ID)).resolves.toEqual(INIT_IMAGE_RESPONSE);
    await expect(client.deleteInitImage(INIT_IMAGE_ID)).resolves.toEqual(
      DELETE_INIT_IMAGE_RESPONSE,
    );
    expect(transport.requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: `${BASE_URL}/init-image/${INIT_IMAGE_ID}` },
      { method: 'DELETE', url: `${BASE_URL}/init-image/${INIT_IMAGE_ID}` },
    ]);
  });
});

describe('LeonardoAiClient variation families', () => {
  it('creates creative upscale and no-background jobs with exact bodies', async () => {
    const { client, transport } = createClient([
      jsonResponse(UPSCALE_RESPONSE),
      jsonResponse(NO_BACKGROUND_RESPONSE),
    ]);

    await expect(client.createUpscale({ id: IMAGE_ID })).resolves.toEqual(UPSCALE_RESPONSE);
    await expect(client.createNoBackground({ id: IMAGE_ID, isVariation: false })).resolves.toEqual(
      NO_BACKGROUND_RESPONSE,
    );
    expect(transport.requests).toEqual([
      {
        url: `${BASE_URL}/variations/upscale`,
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({ id: IMAGE_ID }),
      },
      {
        url: `${BASE_URL}/variations/nobg`,
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({ id: IMAGE_ID, isVariation: false }),
      },
    ]);
  });

  it('creates universal upscale with the complete documented request fixture', async () => {
    const { client, transport } = createClient([jsonResponse(UNIVERSAL_UPSCALER_RESPONSE)]);

    await expect(client.createUniversalUpscaler(UNIVERSAL_UPSCALER_REQUEST)).resolves.toEqual(
      UNIVERSAL_UPSCALER_RESPONSE,
    );
    expect(transport.requests[0]).toMatchObject({
      url: `${BASE_URL}/variations/universal-upscaler`,
      method: 'POST',
      headers: apiHeaders(true),
      body: JSON.stringify(UNIVERSAL_UPSCALER_REQUEST),
    });
  });

  it('polls variation records until all are terminal', async () => {
    const sleep = vi.fn(async () => undefined);
    const { client } = createClient(
      [jsonResponse(PENDING_VARIATION_RESPONSE), jsonResponse(COMPLETE_VARIATION_RESPONSE)],
      { sleep },
    );

    await expect(
      client.pollVariation(VARIATION_ID, { maxAttempts: 2, intervalMs: 23 }),
    ).resolves.toEqual(COMPLETE_VARIATION_RESPONSE);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(23);
  });
});

describe('LeonardoAiClient models, errors, limits, and exclusions', () => {
  it('lists dynamic platform models without pagination', async () => {
    const { client, transport } = createClient([jsonResponse(PLATFORM_MODELS_RESPONSE)]);

    await expect(client.listPlatformModels()).resolves.toEqual(PLATFORM_MODELS_RESPONSE);
    expect(transport.requests[0]).toEqual({
      url: `${BASE_URL}/platformModels`,
      method: 'GET',
      headers: apiHeaders(),
    });
  });

  it('parses provider errors without leaking the API key', async () => {
    const { client } = createClient([jsonResponse(PROVIDER_ERROR_RESPONSE, 401)]);

    const error = await client
      .createGeneration({ prompt: 'will fail safely' })
      .catch((value) => value);
    expect(error).toBeInstanceOf(LeonardoApiError);
    expect(error).toMatchObject({ status: 401, code: 'access-denied', path: '$' });
    expect(error.message).not.toContain(PLACEHOLDER_API_KEY);
    expect(JSON.stringify(error)).not.toContain(PLACEHOLDER_API_KEY);
  });

  it('redacts an API key even when a provider error body echoes it', async () => {
    const echoed = {
      error: `rejected ${PLACEHOLDER_API_KEY}`,
      path: `$.${PLACEHOLDER_API_KEY}`,
      code: `bad-${PLACEHOLDER_API_KEY}`,
    };
    const { client } = createClient([jsonResponse(echoed, 400)]);

    const error = await client.getGeneration(GENERATION_ID).catch((value) => value);
    expect(error).toBeInstanceOf(LeonardoApiError);
    expect(error.message).toContain('[REDACTED]');
    expect(JSON.stringify(error)).not.toContain(PLACEHOLDER_API_KEY);
  });

  it('rejects empty or header-injecting API keys before transport', () => {
    const transport = new RecordingTransport([]);
    expect(() => new LeonardoAiClient({ apiKey: '', transport })).toThrow('invalid API key');
    expect(() => new LeonardoAiClient({ apiKey: `${PLACEHOLDER_API_KEY}\r\nInjected: true`, transport })).toThrow(
      'invalid API key',
    );
  });

  it('rejects malformed documented statuses as protocol errors', async () => {
    const malformed = {
      ...PENDING_GENERATION_RESPONSE,
      generations_by_pk: { ...PENDING_GENERATION_RESPONSE.generations_by_pk, status: 'QUEUED' },
    };
    const { client } = createClient([jsonResponse(malformed)]);

    await expect(client.getGeneration(GENERATION_ID)).rejects.toThrow('invalid generation status');
  });

  it('exports exact documented base and descriptive default limits', () => {
    expect(LEONARDO_V1_BASE_URL).toBe(BASE_URL);
    expect(LEONARDO_V1_LIMITS).toEqual({
      requestsPerMinute: 2000,
      createGenerationPerMinute: 100,
      createVariationPerMinute: 100,
      concurrentImageGenerationJobs: 10,
      pendingImageGenerationJobs: 200,
      pendingUpscalingJobs: 100,
      presignedUploadExpiresInSeconds: 120,
    });
    expect(LEONARDO_V1_LIMITS).not.toHaveProperty('region');
    expect(LEONARDO_V1_LIMITS).not.toHaveProperty('responseHeaders');
  });

  it('fails closed when an unqueued transport request occurs', async () => {
    const { client } = createClient([]);
    await expect(client.getGeneration(GENERATION_ID)).rejects.toThrow(
      `Unexpected unqueued request: GET ${BASE_URL}/generations/${GENERATION_ID}`,
    );
  });

  it('keeps undocumented and out-of-scope public behavior absent at compile time', () => {
    const { client, transport } = createClient([]);
    if (false) {
      // @ts-expect-error Leonardo documents deletion, not cancellation.
      void client.cancelGeneration(GENERATION_ID);
      // @ts-expect-error Platform-model pagination is not documented.
      void client.listPlatformModels({ limit: 10 });
      // @ts-expect-error Poll timing and attempt cap are mandatory caller inputs.
      void client.pollGeneration(GENERATION_ID);
      // @ts-expect-error Unzoom is outside AU-018.
      void client.createUnzoom({ id: IMAGE_ID });
      // @ts-expect-error Elements are outside the frozen AU-018 surface.
      void client.listElements();
      // @ts-expect-error v2 is outside the frozen AU-018 surface.
      void client.createV2Generation({ model: 'phoenix-v1.0' });
      // @ts-expect-error LCM/realtime is outside the frozen AU-018 surface.
      void client.createLCMGeneration({ prompt: 'excluded' });
      // @ts-expect-error Standalone canvas-init upload is outside AU-018.
      void client.createCanvasInitImageUpload({ extension: 'png' });
      // @ts-expect-error Elements request fields are outside the frozen PRD fields.
      void client.createGeneration({ prompt: 'excluded', elements: [] });
      // @ts-expect-error Adjacent generation fields cannot enlarge the frozen PRD.
      void client.createGeneration({ prompt: 'excluded', scheduler: 'DDIM' });
      // @ts-expect-error Deprecated legacy controlNet is intentionally absent.
      void client.createGeneration({ prompt: 'legacy', controlNet: true });
      // @ts-expect-error Region routing is not in the first-party v1 contract.
      void new LeonardoAiClient({ apiKey: PLACEHOLDER_API_KEY, transport, region: 'eu' });
    }
    expect(client).toBeDefined();
  });

  it('uses encoded path segments rather than interpolating raw IDs', async () => {
    const { client, transport } = createClient([jsonResponse({ generations_by_pk: null })]);
    await client.getGeneration('id/with path');
    expect(transport.requests[0].url).toBe(`${BASE_URL}/generations/id%2Fwith%20path`);
  });

  it('retains model IDs as provider data rather than a hard-coded catalog', () => {
    expect(PLATFORM_MODELS_RESPONSE.custom_models[0].id).toBe(MODEL_ID);
  });
});

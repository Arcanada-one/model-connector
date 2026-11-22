import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { OpenAIImagesConnector } from './openai-images.connector';
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';
import { ProviderNotProvisionedError } from '../errors/provider-not-provisioned.error';

// ─── Mock openai package ──────────────────────────────────────────────────────
vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(function (this: {
    images: { generate: ReturnType<typeof vi.fn> };
    apiKey: string;
  }) {
    this.images = { generate: vi.fn() };
    this.apiKey = 'mock-openai-key';
  });
  return { default: MockOpenAI };
});

// ─── MSW Server — shape verification ─────────────────────────────────────────

const OPENAI_API = 'https://api.openai.com';

const server = setupServer(
  http.post(`${OPENAI_API}/v1/images/generations`, async () => {
    return HttpResponse.json({
      created: Date.now(),
      data: [
        {
          b64_json: 'dGVzdC1pbWFnZQ==',
        },
      ],
      usage: {
        input_tokens_details: { image_tokens: 10, text_tokens: 20 },
        output_tokens_details: { image_tokens: 100, text_tokens: 0 },
      },
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OpenAIImagesConnector', () => {
  let connector: OpenAIImagesConnector;
  let cbManager: CircuitBreakerManager;

  beforeAll(() => {
    cbManager = new CircuitBreakerManager('openai-images', 5, 30_000);
    connector = new OpenAIImagesConnector('mock-openai-key', cbManager);
  });

  it('generates image and returns result', async () => {
    const result = await connector.generate({
      tier: 'premium',
      prompt: 'A sunset over the ocean',
      quality: 'high',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
    });

    expect(result.status).toBe('completed');
    expect(result.routing.chosenProvider).toBe('openai-images');
    expect(result.routing.chosenModel).toBe('openai:gpt-image-2.5-sunburst-high');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('MSW shape verification: sends correct payload to OpenAI', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(`${OPENAI_API}/v1/images/generations`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          created: Date.now(),
          data: [{ b64_json: 'dGVzdC1pbWFnZQ==' }],
        });
      }),
    );

    await connector.generate({
      tier: 'premium',
      prompt: 'MSW shape test',
      quality: 'high',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
    });

    // Verify OpenAI API payload shape
    expect(capturedBody).toMatchObject({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'MSW shape test',
      n: 1,
      quality: 'high',
      output_format: 'png',
    });
  });

  it('throws on 401 Unauthorized', async () => {
    server.use(
      http.post(`${OPENAI_API}/v1/images/generations`, () =>
        HttpResponse.json(
          { error: { message: 'Invalid API key', type: 'invalid_request_error' } },
          { status: 401 },
        ),
      ),
    );

    await expect(
      connector.generate({
        tier: 'premium',
        prompt: 'fail',
        quality: 'high',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
      }),
    ).rejects.toThrow();
  });

  it('uses the API usage breakdown for the reported cost', async () => {
    server.use(
      http.post(`${OPENAI_API}/v1/images/generations`, () =>
        HttpResponse.json({
          created: Date.now(),
          data: [{ b64_json: 'dGVzdA==' }],
          usage: {
            input_tokens_details: { image_tokens: 1_000_000, text_tokens: 1_000_000 },
            output_tokens_details: { image_tokens: 1_000_000, text_tokens: 0 },
          },
        }),
      ),
    );

    const result = await connector.generate({
      tier: 'premium',
      prompt: 'usage cost',
      quality: 'high',
      outputFormat: 'url',
    });
    expect(result.costUsd).toBeCloseTo(21.5);
  });

  it('rejects dimensions the provider will reject before making a request', async () => {
    await expect(
      connector.generate({
        tier: 'premium',
        prompt: 'bad size',
        quality: 'high',
        width: 1000,
        height: 1024,
      }),
    ).rejects.toThrow(/divisible by 16/);
  });
});

// ─── Placeholder detection ────────────────────────────────────────────────────

describe('OpenAIImagesConnector — placeholder credential detection', () => {
  it('throws ProviderNotProvisionedError when api_key is PLACEHOLDER', async () => {
    const cbManager = new CircuitBreakerManager('openai-images-ph', 5, 30_000);
    const connectorWithPlaceholder = new OpenAIImagesConnector('PLACEHOLDER_CONN-0052', cbManager);

    await expect(
      connectorWithPlaceholder.generate({
        tier: 'premium',
        prompt: 'test',
        quality: 'high',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
      }),
    ).rejects.toThrow(ProviderNotProvisionedError);
  });

  it('proceeds to API call when real key provided (mocked)', async () => {
    const cbManager = new CircuitBreakerManager('openai-images-real', 5, 30_000);
    const connectorWithReal = new OpenAIImagesConnector('sk-proj-real123abc', cbManager);

    const result = await connectorWithReal.generate({
      tier: 'premium',
      prompt: 'real key test',
      quality: 'high',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
    });

    expect(result.routing.chosenProvider).toBe('openai-images');
  });
});

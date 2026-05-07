import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { OpenAIImagesConnector } from './openai-images.connector';
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';

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
          url: 'https://oaidalleapiprodscus.blob.core.windows.net/private/test.png',
          revised_prompt: 'A beautiful ocean sunset',
        },
      ],
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
    expect(result.routing.chosenModel).toBe('openai:gpt-image-1-high');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('MSW shape verification: sends correct payload to OpenAI', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(`${OPENAI_API}/v1/images/generations`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          created: Date.now(),
          data: [{ url: 'https://openai.com/test.png', revised_prompt: 'test' }],
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
      model: 'gpt-image-1',
      prompt: 'MSW shape test',
      n: 1,
      quality: 'high',
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
});

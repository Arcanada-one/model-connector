import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { FalAiConnector } from './fal-ai.connector';
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';
import { ProviderNotProvisionedError } from '../errors/provider-not-provisioned.error';

// ─── MSW Server — shape locked from datarim/tasks/CONN-0213-fixtures.md ──────

const FAL_BASE = 'https://fal.run';

function successHandler(modelPath: string) {
  return http.post(`${FAL_BASE}/fal-ai/${modelPath}`, () =>
    HttpResponse.json({
      images: [
        {
          url: 'https://v3b.fal.media/files/b/test/abc123.jpg',
          width: 1024,
          height: 1024,
          content_type: 'image/jpeg',
        },
      ],
      timings: { inference: 0.6006122339995272 },
      seed: 913997279,
      has_nsfw_concepts: [false],
      prompt: 'test prompt',
    }),
  );
}

const server = setupServer(successHandler('flux/dev'), successHandler('flux-pro/v1.1'));

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FalAiConnector', () => {
  // Fresh connector per test: circuit breaker state from failure tests must
  // not leak into the next test (auth_error → instant-open per CircuitBreaker
  // policy; multiple server_error failures hit threshold=5 within one describe).
  let connector: FalAiConnector;

  function freshConnector(label: string): FalAiConnector {
    const cb = new CircuitBreakerManager(`fal-ai-${label}`, 5, 30_000);
    return new FalAiConnector('mock-key-id:mock-secret', cb);
  }

  beforeAll(() => {
    connector = freshConnector('default');
  });

  it('parses success response and returns ImageGenerationResult', async () => {
    const result = await connector.generate({
      tier: 'mid',
      prompt: 'a tiny red apple',
      quality: 'medium',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
      model: 'fal-ai:flux/dev',
    });

    expect(result.status).toBe('completed');
    expect(result.urls).toEqual(['https://v3b.fal.media/files/b/test/abc123.jpg']);
    expect(result.routing.chosenProvider).toBe('fal-ai');
    expect(result.routing.chosenModel).toBe('fal-ai:flux/dev');
    expect(result.costUsd).toBeCloseTo(0.025);
    expect(result.latencyMs).toBe(601); // from timings.inference * 1000, rounded
  });

  it('sends correct payload: Authorization: Key <full>, num_inference_steps:4 for flux/dev', async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedAuth = '';

    server.use(
      http.post(`${FAL_BASE}/fal-ai/flux/dev`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        capturedAuth = request.headers.get('authorization') ?? '';
        return HttpResponse.json({
          images: [{ url: 'https://v3b.fal.media/x.jpg' }],
          timings: { inference: 0.5 },
          seed: 1,
          has_nsfw_concepts: [false],
        });
      }),
    );

    await connector.generate({
      tier: 'mid',
      prompt: 'shape test',
      quality: 'medium',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
      model: 'fal-ai:flux/dev',
      seed: 42,
    });

    expect(capturedAuth).toBe('Key mock-key-id:mock-secret');
    expect(capturedBody.prompt).toBe('shape test');
    expect(capturedBody.image_size).toBe('square_hd');
    expect(capturedBody.num_inference_steps).toBe(4); // flux/dev pin
    expect(capturedBody.seed).toBe(42);
  });

  it('omits num_inference_steps for premium model flux-pro/v1.1', async () => {
    let capturedBody: Record<string, unknown> = {};

    server.use(
      http.post(`${FAL_BASE}/fal-ai/flux-pro/v1.1`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          images: [{ url: 'https://v3b.fal.media/y.jpg', width: 1024, height: 1024 }],
          timings: {},
          seed: 1,
          has_nsfw_concepts: [false],
        });
      }),
    );

    const result = await connector.generate({
      tier: 'premium',
      prompt: 'premium test',
      quality: 'high',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
      model: 'fal-ai:flux-pro/v1.1',
    });

    expect(capturedBody.num_inference_steps).toBeUndefined();
    // timings:{} → latencyMs falls back to wall-time (positive integer)
    expect(typeof result.latencyMs).toBe('number');
    expect(result.routing.chosenModel).toBe('fal-ai:flux-pro/v1.1');
    expect(result.costUsd).toBeCloseTo(0.04);
  });

  it('maps aspectRatio → image_size enum (16:9 → landscape_16_9)', async () => {
    let capturedBody: Record<string, unknown> = {};

    server.use(
      http.post(`${FAL_BASE}/fal-ai/flux/dev`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          images: [{ url: 'https://v3b.fal.media/z.jpg' }],
          timings: { inference: 0.5 },
          has_nsfw_concepts: [false],
        });
      }),
    );

    await connector.generate({
      tier: 'mid',
      prompt: 'landscape test',
      quality: 'medium',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
      model: 'fal-ai:flux/dev',
      aspectRatio: '16:9',
    });

    expect(capturedBody.image_size).toBe('landscape_16_9');
  });

  it('throws on 401 (auth error) with body detail surfaced in message', async () => {
    server.use(
      http.post(`${FAL_BASE}/fal-ai/flux/dev`, () =>
        HttpResponse.json(
          { detail: "Cannot access application 'fal-ai/flux'. Authentication is required." },
          { status: 401 },
        ),
      ),
    );

    await expect(
      freshConnector('401').generate({
        tier: 'mid',
        prompt: 'fail',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
        model: 'fal-ai:flux/dev',
      }),
    ).rejects.toThrow(/Fal\.ai auth error 401/);
  });

  it('throws on 404 (unknown model) with status in message', async () => {
    server.use(
      http.post(`${FAL_BASE}/fal-ai/unknown-model`, () =>
        HttpResponse.json({ detail: "Application 'unknown-model' not found" }, { status: 404 }),
      ),
    );

    await expect(
      freshConnector('404').generate({
        tier: 'mid',
        prompt: 'fail',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
        model: 'fal-ai:unknown-model',
      }),
    ).rejects.toThrow(/Fal\.ai API error 404/);
  });

  it('throws on 429 rate limit', async () => {
    server.use(
      http.post(`${FAL_BASE}/fal-ai/flux/dev`, () =>
        HttpResponse.json({ detail: 'Rate limit exceeded' }, { status: 429 }),
      ),
    );

    await expect(
      freshConnector('429').generate({
        tier: 'mid',
        prompt: 'fail',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
        model: 'fal-ai:flux/dev',
      }),
    ).rejects.toThrow(/Fal\.ai API error 429/);
  });

  it('throws on empty images array', async () => {
    server.use(
      http.post(`${FAL_BASE}/fal-ai/flux/dev`, () =>
        HttpResponse.json({ images: [], timings: { inference: 0.1 }, has_nsfw_concepts: [] }),
      ),
    );

    await expect(
      freshConnector('empty').generate({
        tier: 'mid',
        prompt: 'fail',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
        model: 'fal-ai:flux/dev',
      }),
    ).rejects.toThrow(/missing images/);
  });
});

// ─── Placeholder detection ────────────────────────────────────────────────────

describe('FalAiConnector — placeholder credential detection', () => {
  it('throws ProviderNotProvisionedError when api_key is PLACEHOLDER', async () => {
    const cbManager = new CircuitBreakerManager('fal-ai-ph', 5, 30_000);
    const connectorWithPlaceholder = new FalAiConnector('PLACEHOLDER_CONN-0213', cbManager);

    await expect(
      connectorWithPlaceholder.generate({
        tier: 'mid',
        prompt: 'test',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
      }),
    ).rejects.toThrow(ProviderNotProvisionedError);
  });

  it('throws ProviderNotProvisionedError when api_key is empty string', async () => {
    const cbManager = new CircuitBreakerManager('fal-ai-empty', 5, 30_000);
    const connectorWithEmpty = new FalAiConnector('', cbManager);

    await expect(
      connectorWithEmpty.generate({
        tier: 'mid',
        prompt: 'test',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
      }),
    ).rejects.toThrow(ProviderNotProvisionedError);
  });
});

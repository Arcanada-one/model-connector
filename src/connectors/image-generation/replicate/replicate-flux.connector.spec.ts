import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ReplicateFluxConnector } from './replicate-flux.connector';
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';
import { ProviderNotProvisionedError } from '../errors/provider-not-provisioned.error';

// ─── Mock replicate npm package ───────────────────────────────────────────────
vi.mock('replicate', () => {
  const MockReplicate = vi.fn().mockImplementation(function (this: {
    predictions: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    auth: string;
  }) {
    this.predictions = { create: vi.fn(), get: vi.fn() };
    this.auth = 'mock-replicate-token';
  });
  return { default: MockReplicate };
});

// ─── MSW Server — intercepts Replicate API calls for shape verification ───────

const REPLICATE_API = 'https://api.replicate.com';

const server = setupServer(
  http.post(`${REPLICATE_API}/v1/models/black-forest-labs/flux-pro/predictions`, async () => {
    return HttpResponse.json({
      id: 'test-prediction-id',
      status: 'starting',
      urls: { get: `${REPLICATE_API}/v1/predictions/test-prediction-id` },
    });
  }),

  http.get(`${REPLICATE_API}/v1/predictions/test-prediction-id`, () => {
    return HttpResponse.json({
      id: 'test-prediction-id',
      status: 'succeeded',
      output: ['https://replicate.delivery/pbxt/test-image.png'],
      metrics: { predict_time: 12.5 },
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReplicateFluxConnector', () => {
  let connector: ReplicateFluxConnector;
  let cbManager: CircuitBreakerManager;

  beforeAll(() => {
    cbManager = new CircuitBreakerManager('replicate', 5, 30_000);
    connector = new ReplicateFluxConnector('mock-replicate-token', cbManager);
  });

  it('creates prediction and returns job result', async () => {
    const result = await connector.generate({
      tier: 'premium',
      prompt: 'A cyberpunk cityscape at night',
      quality: 'high',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
    });

    expect(result.routing.chosenProvider).toBe('replicate');
    expect(result.routing.chosenModel).toBe('replicate:flux-pro');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('MSW shape verification: predictions.create receives expected payload shape', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(
        `${REPLICATE_API}/v1/models/black-forest-labs/flux-pro/predictions`,
        async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({
            id: 'shape-check-id',
            status: 'succeeded',
            output: ['https://replicate.delivery/pbxt/shape.png'],
          });
        },
      ),
    );

    await connector.generate({
      tier: 'premium',
      prompt: 'shape test prompt',
      quality: 'high',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
    });

    // Shape: Replicate expects 'input' wrapper
    expect(capturedBody).toMatchObject({
      input: expect.objectContaining({
        prompt: 'shape test prompt',
      }),
    });
  });

  it('throws on API error', async () => {
    server.use(
      http.post(`${REPLICATE_API}/v1/models/black-forest-labs/flux-pro/predictions`, () =>
        HttpResponse.json({ detail: 'Unauthorized' }, { status: 401 }),
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

// ─── Placeholder detection ────────────────────────────────────────────────────

describe('ReplicateFluxConnector — placeholder credential detection', () => {
  it('throws ProviderNotProvisionedError when api_token is PLACEHOLDER', async () => {
    const cbManager = new CircuitBreakerManager('replicate-ph', 5, 30_000);
    const connectorWithPlaceholder = new ReplicateFluxConnector('PLACEHOLDER_CONN-0052', cbManager);

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

  it('proceeds to API call when real token provided (mocked)', async () => {
    const cbManager = new CircuitBreakerManager('replicate-real', 5, 30_000);
    const connectorWithReal = new ReplicateFluxConnector('r8_real_token_abc123', cbManager);

    const result = await connectorWithReal.generate({
      tier: 'premium',
      prompt: 'real token test',
      quality: 'high',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
    });

    expect(result.routing.chosenProvider).toBe('replicate');
  });
});

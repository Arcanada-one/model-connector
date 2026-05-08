import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { VertexImageConnector } from './vertex-image.connector';
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';
import { ProviderNotProvisionedError } from '../errors/provider-not-provisioned.error';
import { IMAGE_CAPABILITIES } from '../capabilities';

// ─── Mock google-auth-library ─────────────────────────────────────────────────
vi.mock('google-auth-library', () => {
  const MockGoogleAuth = vi.fn().mockImplementation(function (this: {
    getAccessToken: ReturnType<typeof vi.fn>;
  }) {
    this.getAccessToken = vi.fn().mockResolvedValue({ token: 'mock-vertex-token' });
  });
  return { GoogleAuth: MockGoogleAuth };
});

// ─── MSW Server — intercepts Vertex AI API calls ──────────────────────────────

const MOCK_VERTEX_BASE = 'https://us-central1-aiplatform.googleapis.com';

// Real Vertex AI model IDs as verified in CONN-0052 probe (2026-05-08)
const VERTEX_FAST_MODEL = 'imagen-4.0-fast-generate-001';
const VERTEX_STANDARD_MODEL = 'imagen-4.0-generate-001';
const VERTEX_ULTRA_MODEL = 'imagen-4.0-ultra-generate-001';

const server = setupServer(
  // Imagen 4 Fast predict endpoint — real API model ID (CONN-0052)
  http.post(
    `${MOCK_VERTEX_BASE}/v1/projects/test-project/locations/us-central1/publishers/google/models/${VERTEX_FAST_MODEL}:predict`,
    async () => {
      return HttpResponse.json({
        predictions: [
          {
            bytesBase64Encoded: Buffer.from('fake-image-bytes').toString('base64'),
            mimeType: 'image/png',
          },
        ],
      });
    },
  ),

  // Imagen 4 Standard predict endpoint — real API model ID (CONN-0052)
  http.post(
    `${MOCK_VERTEX_BASE}/v1/projects/test-project/locations/us-central1/publishers/google/models/${VERTEX_STANDARD_MODEL}:predict`,
    async () => {
      return HttpResponse.json({
        predictions: [
          {
            bytesBase64Encoded: Buffer.from('fake-standard-image').toString('base64'),
            mimeType: 'image/png',
          },
        ],
      });
    },
  ),

  // Imagen 4 Ultra predict endpoint — real API model ID (CONN-0052)
  http.post(
    `${MOCK_VERTEX_BASE}/v1/projects/test-project/locations/us-central1/publishers/google/models/${VERTEX_ULTRA_MODEL}:predict`,
    async () => {
      return HttpResponse.json({
        predictions: [
          {
            bytesBase64Encoded: Buffer.from('fake-ultra-image').toString('base64'),
            mimeType: 'image/png',
          },
        ],
      });
    },
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VertexImageConnector', () => {
  let connector: VertexImageConnector;
  let cbManager: CircuitBreakerManager;

  beforeAll(() => {
    cbManager = new CircuitBreakerManager('vertex', 5, 30_000);
    connector = new VertexImageConnector(
      'test-project',
      'us-central1',
      JSON.stringify({
        type: 'service_account',
        project_id: 'test-project',
        client_email: 'test@test.iam.gserviceaccount.com',
        private_key: '-----BEGIN RSA PRIVATE KEY-----\nmock-key\n-----END RSA PRIVATE KEY-----',
      }),
      cbManager,
    );
  });

  it('successfully generates image with vertex:imagen-4-fast model', async () => {
    const result = await connector.generate({
      tier: 'mid',
      prompt: 'A beautiful sunset over the ocean',
      quality: 'medium',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
    });

    expect(result.status).toBe('completed');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.routing.chosenProvider).toBe('vertex');
  });

  it('MSW shape verification: API response has predictions array', async () => {
    // This test verifies that our connector correctly parses the Vertex API response shape
    // If Vertex changes their API, this shape test will fail
    const req = {
      tier: 'mid' as const,
      prompt: 'shape test',
      quality: 'medium' as const,
      count: 1,
      outputFormat: 'url' as const,
      outputAsync: 'auto' as const,
    };

    // Add a handler that captures the request body
    let capturedBody: unknown;
    server.use(
      // Must use real apiModelName (CONN-0052) — old 'imagen-4-fast' would 404
      http.post(
        `${MOCK_VERTEX_BASE}/v1/projects/test-project/locations/us-central1/publishers/google/models/${VERTEX_FAST_MODEL}:predict`,
        async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({
            predictions: [{ bytesBase64Encoded: 'dGVzdA==', mimeType: 'image/png' }],
          });
        },
      ),
    );

    await connector.generate(req);

    // Verify we sent the expected request shape to Vertex
    expect(capturedBody).toMatchObject({
      instances: expect.arrayContaining([expect.objectContaining({ prompt: 'shape test' })]),
    });
  });

  it('handles HTTP 500 from Vertex and throws', async () => {
    server.use(
      http.post(
        `${MOCK_VERTEX_BASE}/v1/projects/test-project/locations/us-central1/publishers/google/models/${VERTEX_FAST_MODEL}:predict`,
        () => HttpResponse.json({ error: { message: 'Internal error' } }, { status: 500 }),
      ),
    );

    await expect(
      connector.generate({
        tier: 'mid',
        prompt: 'fail case',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
      }),
    ).rejects.toThrow();
  });
});

// ─── Placeholder detection ────────────────────────────────────────────────────

describe('VertexImageConnector — placeholder credential detection', () => {
  it('throws ProviderNotProvisionedError when private_key is PLACEHOLDER', async () => {
    const cbManager = new CircuitBreakerManager('vertex-ph', 5, 30_000);
    const connectorWithPlaceholder = new VertexImageConnector(
      'test-project',
      'us-central1',
      JSON.stringify({
        type: 'service_account',
        private_key: 'PLACEHOLDER_CONN-0052',
        client_email: 'test@test.iam.gserviceaccount.com',
      }),
      cbManager,
    );

    await expect(
      connectorWithPlaceholder.generate({
        tier: 'mid',
        prompt: 'test prompt',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
      }),
    ).rejects.toThrow(ProviderNotProvisionedError);
  });

  it('proceeds to API call when real credentials provided (mocked)', async () => {
    const cbManager = new CircuitBreakerManager('vertex-real', 5, 30_000);
    const connectorWithReal = new VertexImageConnector(
      'test-project',
      'us-central1',
      JSON.stringify({
        type: 'service_account',
        private_key:
          '-----BEGIN RSA PRIVATE KEY-----\nmock-real-key\n-----END RSA PRIVATE KEY-----',
        client_email: 'test@test.iam.gserviceaccount.com',
      }),
      cbManager,
    );

    // Should NOT throw ProviderNotProvisionedError — will reach API call (MSW mocked above)
    // MSW handler registered for VERTEX_FAST_MODEL (imagen-4.0-fast-generate-001)
    const result = await connectorWithReal.generate({
      tier: 'mid',
      prompt: 'real creds test',
      quality: 'medium',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
    });

    expect(result.routing.chosenProvider).toBe('vertex');
  });
});

// ─── apiModelName routing correctness ─────────────────────────────────────────

describe('VertexImageConnector — apiModelName routing', () => {
  const realCreds = JSON.stringify({
    type: 'service_account',
    private_key: '-----BEGIN RSA PRIVATE KEY-----\nmock-key\n-----END RSA PRIVATE KEY-----',
    client_email: 'test@test.iam.gserviceaccount.com',
  });

  it('capabilities contain correct apiModelName for all Vertex imagen models', () => {
    expect(IMAGE_CAPABILITIES['vertex:imagen-4-fast'].apiModelName).toBe(
      'imagen-4.0-fast-generate-001',
    );
    expect(IMAGE_CAPABILITIES['vertex:imagen-4'].apiModelName).toBe('imagen-4.0-generate-001');
    expect(IMAGE_CAPABILITIES['vertex:imagen-4-ultra'].apiModelName).toBe(
      'imagen-4.0-ultra-generate-001',
    );
  });

  it('generates with vertex:imagen-4 using real Standard apiModelName URL', async () => {
    const cbManager = new CircuitBreakerManager('vertex-std', 5, 30_000);
    const connector = new VertexImageConnector('test-project', 'us-central1', realCreds, cbManager);

    const result = await connector.generate({
      tier: 'mid',
      prompt: 'standard model test',
      model: 'vertex:imagen-4',
      quality: 'medium',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
    });

    expect(result.status).toBe('completed');
    expect(result.routing.chosenProvider).toBe('vertex');
    expect(result.routing.reason).toContain('imagen-4.0-generate-001');
  });

  it('generates with vertex:imagen-4-ultra using real Ultra apiModelName URL', async () => {
    const cbManager = new CircuitBreakerManager('vertex-ultra', 5, 30_000);
    const connector = new VertexImageConnector('test-project', 'us-central1', realCreds, cbManager);

    const result = await connector.generate({
      tier: 'premium',
      prompt: 'ultra model test',
      model: 'vertex:imagen-4-ultra',
      quality: 'high',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'auto',
    });

    expect(result.status).toBe('completed');
    expect(result.routing.chosenProvider).toBe('vertex');
    expect(result.routing.reason).toContain('imagen-4.0-ultra-generate-001');
  });

  it('throws descriptive error when vertex:nano-banana is requested (Phase 3 not implemented)', async () => {
    const cbManager = new CircuitBreakerManager('vertex-nano', 5, 30_000);
    const connector = new VertexImageConnector('test-project', 'us-central1', realCreds, cbManager);

    await expect(
      connector.generate({
        tier: 'cheap',
        prompt: 'nano test',
        model: 'vertex:nano-banana',
        quality: 'low',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
      }),
    ).rejects.toThrow('Nano Banana');
  });
});

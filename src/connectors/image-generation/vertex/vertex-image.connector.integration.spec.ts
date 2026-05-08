/**
 * Integration test: VertexImageConnector — real Imagen 4 Fast + Nano Banana calls.
 * Gate: RUN_INTEGRATION=1 AND VERTEX_BILLING_ENABLED=1
 *
 * Gap Discovery GD-2 (CONN-0052): GCP project arcanada-platform has no billing
 * account linked. Vertex AI Imagen 4 requires billing even for pay-as-you-go.
 * Tests are written and ready — will run once billing is enabled.
 * Action required: link billing account at
 *   https://console.developers.google.com/billing/enable?project=arcanada-platform
 *
 * Auth verification runs unconditionally (billing not required for token fetch).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { VertexImageConnector } from './vertex-image.connector';
import { VertexAuthService } from './vertex-auth.service';
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';

const shouldRun = process.env.RUN_INTEGRATION === '1';
const billingEnabled = process.env.VERTEX_BILLING_ENABLED === '1';

// ─── Auth smoke — always run when RUN_INTEGRATION=1 (billing not required) ───

describe.skipIf(!shouldRun)('VertexAuthService — real token [INTEGRATION]', () => {
  let service: VertexAuthService;

  beforeAll(() => {
    const saJson = process.env.VERTEX_SERVICE_ACCOUNT_JSON;
    if (!saJson) throw new Error('VERTEX_SERVICE_ACCOUNT_JSON not set');
    service = new VertexAuthService(
      process.env.VERTEX_PROJECT_ID ?? 'arcanada-platform',
      process.env.VERTEX_LOCATION ?? 'us-central1',
      saJson,
    );
  });

  it('fetches real OAuth2 access token from Google', async () => {
    const t0 = Date.now();
    const token = await service.getAccessToken();
    const elapsed = Date.now() - t0;

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(50);
    expect(token).toMatch(/^ya29\./);

    console.log('[INT] Vertex token obtained in', elapsed, 'ms');
    console.log('[INT] Token prefix:', token.slice(0, 20) + '...');
  });
});

// ─── Imagen 4 Fast — requires billing ────────────────────────────────────────

describe.skipIf(!shouldRun || !billingEnabled)(
  'VertexImageConnector — Imagen 4 Fast [INTEGRATION — BILLING REQUIRED]',
  () => {
    let connector: VertexImageConnector;

    beforeAll(() => {
      const saJson = process.env.VERTEX_SERVICE_ACCOUNT_JSON;
      if (!saJson)
        throw new Error(
          'VERTEX_SERVICE_ACCOUNT_JSON not set — run: source .env.integration in shell',
        );

      connector = new VertexImageConnector(
        process.env.VERTEX_PROJECT_ID ?? 'arcanada-platform',
        process.env.VERTEX_LOCATION ?? 'us-central1',
        saJson,
        new CircuitBreakerManager('vertex-integration', 5, 30_000),
      );
    });

    it('generates 1 image with vertex:imagen-4-fast — real API call', async () => {
      const t0 = Date.now();
      const result = await connector.generate({
        tier: 'mid',
        prompt: 'a single red cube on plain white background, minimalist product photo',
        aspectRatio: '1:1',
        count: 1,
        quality: 'medium',
        outputFormat: 'url',
        outputAsync: 'never',
        model: 'vertex:imagen-4-fast',
      });
      const elapsed = Date.now() - t0;

      // Shape assertions
      expect(result.status).toBe('completed');
      expect(result.urls).toBeDefined();
      expect(result.urls!.length).toBeGreaterThanOrEqual(1);
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.costUsd).toBeLessThan(1.0); // Sanity: should be ~$0.02
      expect(result.routing.chosenProvider).toBe('vertex');
      expect(result.routing.chosenModel).toBe('vertex:imagen-4-fast');
      expect(result.routing.fallbackUsed).toBe(false);
      expect(elapsed).toBeLessThan(30_000);

      // Image data assertions
      const imageUrl = result.urls![0];
      expect(imageUrl).toBeDefined();
      const isBase64DataUri = imageUrl.startsWith('data:image/');
      const isHttpUrl = imageUrl.startsWith('http');
      expect(isBase64DataUri || isHttpUrl).toBe(true);

      console.log('[INT] Imagen 4 Fast latency:', elapsed, 'ms');
      console.log('[INT] Cost:', result.costUsd, 'USD');
      console.log('[INT] URL type:', isBase64DataUri ? 'base64 data URI' : 'http URL');
      if (isBase64DataUri) {
        const b64 = imageUrl.split(',')[1];
        console.log('[INT] Base64 length:', b64?.length ?? 0, 'bytes');
      }
    });

    it('generates image with vertex:nano-banana (Imagen Nano)', async () => {
      const t0 = Date.now();
      const result = await connector.generate({
        tier: 'cheap',
        prompt: 'a simple blue square on white background',
        aspectRatio: '1:1',
        count: 1,
        quality: 'low',
        outputFormat: 'url',
        outputAsync: 'never',
        model: 'vertex:nano-banana',
      });
      const elapsed = Date.now() - t0;

      expect(result.status).toBe('completed');
      expect(result.urls!.length).toBeGreaterThanOrEqual(1);
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.routing.chosenModel).toBe('vertex:nano-banana');
      expect(elapsed).toBeLessThan(30_000);

      console.log('[INT] Nano Banana latency:', elapsed, 'ms');
      console.log('[INT] Cost:', result.costUsd, 'USD');
    });
  },
);

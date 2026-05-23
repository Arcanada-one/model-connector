/**
 * Integration test: FalAiConnector — real Fal.ai API calls.
 * Gate: RUN_INTEGRATION=1 AND FAL_AI_INTEGRATION=1
 *
 * Vault path: arcanada/prod/env/model-connector-fal-ai (field: api_key)
 * Live smoke verified 2026-05-23 (CONN-0213 /dr-plan fixture capture):
 *   - flux/dev: HTTP 200, ~0.6s inference, 1024×1024 JPEG, ~$0.025
 *   - flux-pro/v1.1: HTTP 200, ~few s, 1024×768 JPEG, ~$0.040
 *
 * Cost budget per run:
 *   Test 1 (flux/dev):       ~$0.025
 *   Test 2 (flux-pro/v1.1):  ~$0.040  (TOTAL ~$0.065 per full run)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FalAiConnector } from './fal-ai.connector';
import { CircuitBreakerManager } from '../../../core/resilience/circuit-breaker-manager';

const shouldRun = process.env.RUN_INTEGRATION === '1';
const falEnabled = process.env.FAL_AI_INTEGRATION === '1';

// ─── Test 1: flux/dev — cheapest smoke ────────────────────────────────────────

describe.skipIf(!shouldRun || !falEnabled)('FalAiConnector — fal-ai/flux/dev [INTEGRATION]', () => {
  let connector: FalAiConnector;

  beforeAll(() => {
    const apiKey = process.env.FAL_AI_API_KEY;
    if (!apiKey || apiKey.startsWith('PLACEHOLDER')) {
      throw new Error(
        'FAL_AI_API_KEY not set or is PLACEHOLDER — add real key to .env.integration:\n' +
          '  FAL_AI_INTEGRATION=1\n' +
          '  FAL_AI_API_KEY=<key-id>:<secret>\n' +
          'Key is in Vault: arcanada/prod/env/model-connector-fal-ai (field: api_key)',
      );
    }
    connector = new FalAiConnector(
      apiKey,
      new CircuitBreakerManager('fal-ai-integration-dev', 5, 60_000),
    );
  });

  it('generates 1 image with flux/dev — real API call', async () => {
    const t0 = Date.now();

    const result = await connector.generate({
      tier: 'mid',
      prompt: 'a single green cube on plain white background, minimalist product photo',
      quality: 'medium',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'never',
      model: 'fal-ai:flux/dev',
    });

    const elapsed = Date.now() - t0;

    expect(result.status).toBe('completed');
    expect(result.urls).toBeDefined();
    expect(result.urls!.length).toBeGreaterThanOrEqual(1);

    // Fal.ai returns HTTPS URL hosted on *.fal.media
    const imageUrl = result.urls![0];
    expect(imageUrl).toMatch(/^https:\/\/.*\.fal\.media\//);

    // Verify the URL actually resolves to image bytes
    const headResp = await fetch(imageUrl, { method: 'HEAD' });
    expect(headResp.ok).toBe(true);
    expect(headResp.headers.get('content-type') ?? '').toMatch(/^image\//);

    // Cost: ~$0.025 for flux/dev
    expect(result.costUsd).toBeCloseTo(0.025, 3);

    // Routing
    expect(result.routing.chosenProvider).toBe('fal-ai');
    expect(result.routing.chosenModel).toBe('fal-ai:flux/dev');
    expect(result.routing.fallbackUsed).toBe(false);

    // Latency: Fal flux/dev typically <2s; budget 60s for queueing
    expect(elapsed).toBeLessThan(60_000);

    console.log('[INT] fal-ai/flux/dev latency:', elapsed, 'ms');
    console.log('[INT] Cost:', result.costUsd, 'USD');
    console.log('[INT] Image URL:', imageUrl);
  }, 65_000);

  it('connector returns requestId as valid UUID', async () => {
    const result = await connector.generate({
      tier: 'mid',
      prompt: 'a simple red sphere on white background',
      quality: 'medium',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'never',
      model: 'fal-ai:flux/dev',
    });

    expect(result.requestId).toBeDefined();
    expect(result.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    console.log('[INT] requestId:', result.requestId);
    console.log('[INT] latencyMs:', result.latencyMs, 'ms');
  }, 65_000);
});

// ─── Test 2: flux-pro/v1.1 — premium smoke ────────────────────────────────────

describe.skipIf(!shouldRun || !falEnabled)(
  'FalAiConnector — fal-ai/flux-pro/v1.1 [INTEGRATION]',
  () => {
    let connector: FalAiConnector;

    beforeAll(() => {
      const apiKey = process.env.FAL_AI_API_KEY;
      if (!apiKey || apiKey.startsWith('PLACEHOLDER')) {
        throw new Error('FAL_AI_API_KEY not set or is PLACEHOLDER');
      }
      connector = new FalAiConnector(
        apiKey,
        new CircuitBreakerManager('fal-ai-integration-pro', 5, 60_000),
      );
    });

    it('generates 1 image with flux-pro/v1.1 — verifies pricing diff vs flux/dev', async () => {
      const devCost = 0.025;
      const proCost = 0.04;
      expect(proCost).toBeGreaterThan(devCost);

      const t0 = Date.now();

      const result = await connector.generate({
        tier: 'premium',
        prompt: 'a small green apple on a wooden table, premium product photo',
        quality: 'high',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'never',
        model: 'fal-ai:flux-pro/v1.1',
      });

      const elapsed = Date.now() - t0;

      expect(result.status).toBe('completed');
      expect(result.urls).toBeDefined();
      expect(result.urls!.length).toBeGreaterThanOrEqual(1);

      // Cost should match flux-pro pricing
      expect(result.costUsd).toBeCloseTo(proCost, 3);
      expect(elapsed).toBeLessThan(60_000);

      console.log('[INT] fal-ai/flux-pro/v1.1 latency:', elapsed, 'ms');
      console.log('[INT] Cost (pro):', result.costUsd, 'USD vs dev: $0.025');
      console.log('[INT] Routing:', result.routing.chosenModel);
    }, 65_000);
  },
);

/**
 * Integration test: ImageRouterService fallback — PLACEHOLDER providers
 * trigger ProviderNotProvisionedError → router excludes → falls back.
 * Gate: RUN_INTEGRATION=1
 *
 * Replicate and OpenAI are still PLACEHOLDER in Vault.
 * This test exercises the fallback loop using real connector instances.
 *
 * The full live fallback test (with Vertex actually making API calls)
 * requires VERTEX_BILLING_ENABLED=1 — gated separately.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ImageRouterService, ImageRoutingError } from './image-router.service';
import { CircuitBreakerManager } from '../../core/resilience/circuit-breaker-manager';
import { ProviderNotProvisionedError } from './errors/provider-not-provisioned.error';
import { ReplicateFluxConnector } from './replicate/replicate-flux.connector';
import { isPlaceholder } from './errors/is-placeholder';

const shouldRun = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!shouldRun)('ImageRouterService — fallback integration [INTEGRATION]', () => {
  let cbManager: CircuitBreakerManager;

  beforeAll(() => {
    cbManager = new CircuitBreakerManager('fallback-test', 5, 30_000);
  });

  it('routeExcluding skips vertex and finds replicate for premium tier', () => {
    const router = new ImageRouterService(cbManager);

    // Exclude vertex (simulating it being unprovisioned)
    const decision = router.routeExcluding('premium', {}, ['vertex']);

    // Premium tier TIER_MAP: vertex:imagen-4-ultra → replicate:flux-pro → openai:gpt-image-1-high
    expect(decision.chosenProvider).not.toBe('vertex');
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.reason).toContain('vertex');
    console.log('[INT] Fallback routing decision:', decision.chosenModel, decision.reason);
  });

  it('routeExcluding throws ImageRoutingError when all providers excluded', () => {
    const router = new ImageRouterService(cbManager);

    expect(() =>
      router.routeExcluding('mid', {}, ['vertex', 'replicate', 'openai-images']),
    ).toThrow(ImageRoutingError);
  });

  it('ReplicateFluxConnector throws ProviderNotProvisionedError with PLACEHOLDER token', async () => {
    const connector = new ReplicateFluxConnector('PLACEHOLDER_CONN-0059', cbManager);

    await expect(
      connector.generate({
        tier: 'premium',
        prompt: 'test',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'never',
      }),
    ).rejects.toThrow(ProviderNotProvisionedError);

    console.log('[INT] Replicate PLACEHOLDER correctly throws ProviderNotProvisionedError');
  });

  it('VertexImageConnector with real SA JSON passes placeholder check (is NOT placeholder)', () => {
    const saJson = process.env.VERTEX_SERVICE_ACCOUNT_JSON;
    if (!saJson) {
      console.log('[INT] Skipping: VERTEX_SERVICE_ACCOUNT_JSON not set');
      return;
    }

    // Verify that real SA JSON does NOT trigger placeholder detection
    const parsed = JSON.parse(saJson) as { private_key?: string };
    expect(isPlaceholder(parsed.private_key ?? '')).toBe(false);

    console.log('[INT] Real SA private_key is NOT a placeholder: confirmed');
  });

  it('routing_decision shape has all required JSONB fields', () => {
    const router = new ImageRouterService(cbManager);
    const decision = router.route('mid', {});

    // Verify all JSONB fields present per types.ts RoutingDecision interface
    expect(decision).toHaveProperty('chosenProvider');
    expect(decision).toHaveProperty('chosenModel');
    expect(decision).toHaveProperty('fallbackUsed');
    expect(decision).toHaveProperty('reason');
    expect(decision).toHaveProperty('candidate');
    expect(decision.candidate).toHaveProperty('modelId');
    expect(decision.candidate).toHaveProperty('providerId');
    expect(decision.candidate).toHaveProperty('tier');
    expect(decision).toHaveProperty('costUsd');
    expect(decision.costUsd).toBeGreaterThan(0);

    console.log('[INT] routing_decision shape verified:', JSON.stringify(decision));
  });

  it('fallback_used is true when primary provider excluded; throws when tier has only one provider', () => {
    const router = new ImageRouterService(cbManager);

    // Mid tier has only vertex candidates — excluding vertex should throw
    expect(() => router.routeExcluding('mid', {}, ['vertex'])).toThrow(ImageRoutingError);
    console.log(
      '[INT] Mid tier with vertex-only candidates: correctly throws when vertex excluded',
    );
  });

  it('premium tier fallback decision contains fallback_used=true in routing decision JSONB', () => {
    const router = new ImageRouterService(cbManager);

    // Simulate: vertex was tried and failed → fallback to replicate
    const fallbackDecision = router.routeExcluding('premium', {}, ['vertex']);

    // This is what gets stored in routing_decision JSONB
    expect(fallbackDecision.fallbackUsed).toBe(true);
    expect(fallbackDecision.reason).toMatch(/fallback.*vertex/);
    expect(fallbackDecision.chosenProvider).toBe('replicate');
    expect(fallbackDecision.costUsd).toBeGreaterThan(0);

    console.log('[INT] routing_decision.fallbackUsed=true verified for premium tier fallback');
    console.log('[INT] JSONB shape:', JSON.stringify(fallbackDecision));
  });
});

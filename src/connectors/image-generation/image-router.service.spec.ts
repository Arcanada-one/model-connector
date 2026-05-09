import { describe, it, expect, beforeEach } from 'vitest';
import { ImageRouterService, ImageRoutingError } from './image-router.service';
import { CircuitBreakerManager } from '../../core/resilience/circuit-breaker-manager';

describe('ImageRouterService', () => {
  let router: ImageRouterService;

  beforeEach(() => {
    router = new ImageRouterService();
  });

  describe('primary path — TIER_MAP lookup', () => {
    it('routes cheap tier to vertex:nano-banana', () => {
      const decision = router.route('cheap', {});
      expect(decision.chosenModel).toBe('vertex:nano-banana');
      expect(decision.chosenProvider).toBe('vertex');
      expect(decision.fallbackUsed).toBe(false);
    });

    it('routes mid tier to vertex:imagen-4-fast', () => {
      const decision = router.route('mid', {});
      expect(decision.chosenModel).toBe('vertex:imagen-4-fast');
      expect(decision.fallbackUsed).toBe(false);
    });

    it('routes premium tier to vertex:imagen-4-ultra', () => {
      const decision = router.route('premium', {});
      expect(decision.chosenModel).toBe('vertex:imagen-4-ultra');
      expect(decision.chosenProvider).toBe('vertex');
      expect(decision.fallbackUsed).toBe(false);
    });
  });

  describe('fallback path — primary circuit open', () => {
    it('falls back to next in tier list when primary circuit is open', () => {
      // Open circuit for the primary model of 'premium' tier
      const cbManager = new CircuitBreakerManager('image-router', 1, 999_999);
      // Force circuit open by recording threshold failures
      const cb = cbManager.getCircuitBreaker('vertex:imagen-4-ultra');
      for (let i = 0; i < 5; i++) {
        cb.recordFailure('server_error');
      }

      router = new ImageRouterService(cbManager);
      const decision = router.route('premium', {});
      expect(decision.fallbackUsed).toBe(true);
      expect(decision.chosenModel).not.toBe('vertex:imagen-4-ultra');
      expect(decision.reason).toContain('fallback');
    });
  });

  describe('all providers down', () => {
    it('throws ImageRoutingError when all models in tier have open circuits', () => {
      // Create CBManager with threshold=1 so one failure opens the circuit
      const cbManager = new CircuitBreakerManager('image-router', 1, 999_999);
      // Open circuits for ALL cheap tier models
      for (const modelId of ['vertex:nano-banana']) {
        const cb = cbManager.getCircuitBreaker(modelId);
        for (let i = 0; i < 5; i++) cb.recordFailure('server_error');
      }

      router = new ImageRouterService(cbManager);
      // Cheap has only 1 active model (codex disabled), so all are open
      expect(() => router.route('cheap', {})).toThrow();
    });
  });

  describe('model pin (bypass tier routing)', () => {
    it('returns pinned model directly without fallback', () => {
      const decision = router.route('mid', { model: 'replicate:flux-pro' });
      expect(decision.chosenModel).toBe('replicate:flux-pro');
      expect(decision.chosenProvider).toBe('replicate');
      expect(decision.fallbackUsed).toBe(false);
      expect(decision.reason).toContain('pinned');
    });
  });

  describe('routeExcluding — skip unprovisioned providers', () => {
    it('skips excluded provider and returns next in tier', () => {
      const decision = router.routeExcluding('premium', {}, ['vertex']);
      // vertex:imagen-4-ultra is excluded → should fallback to replicate or openai-images
      expect(decision.chosenProvider).not.toBe('vertex');
      expect(decision.fallbackUsed).toBe(true);
    });

    it('throws ImageRoutingError when all providers excluded', () => {
      expect(() => router.routeExcluding('cheap', {}, ['vertex'])).toThrow(ImageRoutingError);
    });

    it('returns primary if not excluded', () => {
      const decision = router.routeExcluding('cheap', {}, ['replicate']);
      // replicate is excluded but cheap tier only has vertex — should still route to vertex
      expect(decision.chosenProvider).toBe('vertex');
    });
  });

  describe('A1 — RoutingDecision shape enrichment', () => {
    it('includes candidate.modelId, candidate.providerId, candidate.tier in tier routing', () => {
      const decision = router.route('mid', {});
      expect(decision.candidate).toBeDefined();
      expect(decision.candidate.modelId).toBe('vertex:imagen-4-fast');
      expect(decision.candidate.providerId).toBe('vertex');
      expect(decision.candidate.tier).toBe('mid');
    });

    it('includes costUsd (>0) for known model', () => {
      const decision = router.route('mid', {});
      expect(decision.costUsd).toBeGreaterThan(0);
      expect(decision.costUsd).toBeCloseTo(0.02); // vertex:imagen-4-fast pricing
    });

    it('includes candidate and costUsd in pinned-model path', () => {
      const decision = router.route('cheap', { model: 'vertex:nano-banana' });
      expect(decision.candidate.modelId).toBe('vertex:nano-banana');
      expect(decision.candidate.tier).toBe('cheap');
      expect(decision.costUsd).toBeCloseTo(0.039);
    });

    it('includes candidate and costUsd in fallback path', () => {
      const cbManager = new CircuitBreakerManager('image-router', 1, 999_999);
      const cb = cbManager.getCircuitBreaker('vertex:imagen-4-ultra');
      for (let i = 0; i < 5; i++) cb.recordFailure('server_error');
      router = new ImageRouterService(cbManager);

      const decision = router.route('premium', {});
      expect(decision.fallbackUsed).toBe(true);
      expect(decision.candidate.modelId).toBe(decision.chosenModel);
      expect(decision.costUsd).toBeGreaterThan(0);
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { ImageRouterService } from './image-router.service';
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
});

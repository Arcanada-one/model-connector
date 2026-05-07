import { describe, it, expect, beforeEach } from 'vitest';
import { BaseImageConnector } from './base-image.connector';
import { CircuitBreakerManager } from '../../core/resilience/circuit-breaker-manager';
import type { ImageGenerationRequest, ImageGenerationResult } from './types';

// ─── Concrete test subclass ───────────────────────────────────────────────────

class MockImageConnector extends BaseImageConnector {
  public generateCalls = 0;
  public shouldFail = false;

  async generate(_req: ImageGenerationRequest): Promise<ImageGenerationResult> {
    this.generateCalls++;
    if (this.shouldFail) {
      throw new Error('mock generate failure');
    }
    return {
      requestId: 'test-123',
      status: 'completed',
      urls: ['https://example.com/img.png'],
      costUsd: 0.04,
      latencyMs: 500,
      routing: {
        chosenProvider: 'vertex',
        chosenModel: 'vertex:imagen-4',
        fallbackUsed: false,
        reason: 'test',
      },
    };
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BaseImageConnector', () => {
  let connector: MockImageConnector;
  let cbManager: CircuitBreakerManager;

  beforeEach(() => {
    cbManager = new CircuitBreakerManager('mock', 2, 999_999);
    connector = new MockImageConnector(cbManager);
  });

  describe('withCircuit', () => {
    it('executes fn and records success on happy path', async () => {
      const req: ImageGenerationRequest = {
        tier: 'mid',
        prompt: 'test',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
      };
      const result = await connector.withCircuitPublic('vertex:imagen-4', () =>
        connector.generate(req),
      );
      expect(result.status).toBe('completed');
      // CB should remain closed
      const state = cbManager.getCircuitBreaker('vertex:imagen-4').getState();
      expect(state.state).toBe('closed');
    });

    it('records failure and eventually opens circuit', async () => {
      connector.shouldFail = true;
      const req: ImageGenerationRequest = {
        tier: 'mid',
        prompt: 'fail',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
      };

      // Two failures should open circuit (threshold=2)
      for (let i = 0; i < 2; i++) {
        await expect(
          connector.withCircuitPublic('vertex:imagen-4', () => connector.generate(req)),
        ).rejects.toThrow();
      }

      const state = cbManager.getCircuitBreaker('vertex:imagen-4').getState();
      expect(state.state).toBe('open');
    });

    it('throws CircuitOpenError when circuit is already open', async () => {
      // Force open
      const cb = cbManager.getCircuitBreaker('vertex:imagen-4');
      cb.recordFailure('server_error');
      cb.recordFailure('server_error'); // threshold=2

      const req: ImageGenerationRequest = {
        tier: 'mid',
        prompt: 'blocked',
        quality: 'medium',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'auto',
      };

      await expect(
        connector.withCircuitPublic('vertex:imagen-4', () => connector.generate(req)),
      ).rejects.toThrow('Circuit breaker open');
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import type { ImageGenerationService } from './image-generation/image-generation.service';
import type { CascadeRouterService } from './cascade/cascade-router.service';
import { CascadeExhaustedError, CascadeBudgetExceededError } from './cascade/cascade.errors';

// ─── Mock env.schema to avoid DATABASE_URL requirement ───────────────────────
vi.mock('@nestjs/bullmq', () => ({
  InjectQueue: () => () => {},
  BullModule: { registerQueue: vi.fn() },
}));

describe('ConnectorsController', () => {
  const mockService = {
    listAll: vi.fn().mockResolvedValue([{ name: 'test', type: 'cli', capabilities: {} }]),
    getStatus: vi.fn().mockResolvedValue({ name: 'test', healthy: true }),
    execute: vi.fn().mockResolvedValue({ id: '1', status: 'success', result: 'ok' }),
  };

  const mockImageService = {
    handleRequest: vi.fn(),
    shouldRunAsync: vi.fn().mockReturnValue(false),
    processRequest: vi.fn(),
  } as unknown as ImageGenerationService;

  // CONN-0223 F3 — cascade router mock (plan Phase 4)
  const mockCascadeService = {
    execute: vi.fn(),
  } as unknown as CascadeRouterService;

  let controller: ConnectorsController;

  beforeEach(() => {
    controller = new ConnectorsController(
      mockService as unknown as ConnectorsService,
      mockImageService,
      mockCascadeService,
    );
    vi.clearAllMocks();
  });

  it('should list connectors', async () => {
    const result = await controller.listConnectors();
    expect(result).toHaveLength(1);
    expect(mockService.listAll).toHaveBeenCalledOnce();
  });

  it('should get connector status', async () => {
    const result = await controller.getStatus('test');
    expect(result.healthy).toBe(true);
    expect(mockService.getStatus).toHaveBeenCalledWith('test');
  });

  it('should execute per-connector', async () => {
    const req = { apiKey: { id: 'key-1' } };
    const result = await controller.executePerConnector('test', { prompt: 'hi' }, req);
    expect(result.status).toBe('success');
    expect(mockService.execute).toHaveBeenCalledWith('test', { prompt: 'hi' }, 'key-1');
  });

  it('should execute universal', async () => {
    const req = { apiKey: { id: 'key-1' } };
    const result = await controller.executeUniversal({ connector: 'test', prompt: 'hi' }, req);
    expect(result.status).toBe('success');
    expect(mockService.execute).toHaveBeenCalledWith('test', { prompt: 'hi' }, 'key-1');
  });

  // ─── CONN-0223 F3 — Cascade routing via profile (plan Phase 4) ───────────────

  describe('profile routing (cascade dispatch)', () => {
    const successResponse = {
      id: 'casc-1',
      connector: 'openmodel',
      model: 'deepseek-v4-flash',
      result: 'ok',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10, costUsd: 0 },
      latencyMs: 200,
      status: 'success' as const,
    };

    it('dispatches profile:"low-reasoning" to CascadeRouterService', async () => {
      vi.mocked(mockCascadeService.execute).mockResolvedValue(successResponse);
      const req = { apiKey: { id: 'key-2' } };
      const result = await controller.executeUniversal(
        { profile: 'low-reasoning', prompt: 'classify this' } as Parameters<
          typeof controller.executeUniversal
        >[0],
        req,
      );
      expect(result.status).toBe('success');
      expect(mockCascadeService.execute).toHaveBeenCalledWith(
        'low-reasoning',
        { prompt: 'classify this' },
        'key-2',
      );
      // ConnectorsService must NOT be called on the cascade path
      expect(mockService.execute).not.toHaveBeenCalled();
    });

    it('maps CascadeExhaustedError to HTTP 503 with cascade_exhausted body', async () => {
      vi.mocked(mockCascadeService.execute).mockRejectedValue(
        new CascadeExhaustedError([
          { connector: 'openmodel', model: 'deepseek-v4-flash', errorType: 'rate_limited' },
        ]),
      );
      const req = { apiKey: { id: 'key-2' } };
      await expect(
        controller.executeUniversal(
          { profile: 'low-reasoning', prompt: 'hi' } as Parameters<
            typeof controller.executeUniversal
          >[0],
          req,
        ),
      ).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({ error: 'cascade_exhausted' }),
      });
    });

    it('maps CascadeBudgetExceededError to HTTP 503 with budget_exceeded body', async () => {
      vi.mocked(mockCascadeService.execute).mockRejectedValue(
        new CascadeBudgetExceededError(0.17, 0.17),
      );
      const req = { apiKey: { id: 'key-2' } };
      await expect(
        controller.executeUniversal(
          { profile: 'low-reasoning', prompt: 'hi' } as Parameters<
            typeof controller.executeUniversal
          >[0],
          req,
        ),
      ).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({ error: 'budget_exceeded' }),
      });
    });

    it('re-throws unexpected errors from the cascade without wrapping in HttpException', async () => {
      vi.mocked(mockCascadeService.execute).mockRejectedValue(new Error('unexpected'));
      const req = { apiKey: { id: 'key-2' } };
      let caught: unknown;
      try {
        await controller.executeUniversal(
          { profile: 'low-reasoning', prompt: 'hi' } as Parameters<
            typeof controller.executeUniversal
          >[0],
          req,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('unexpected');
      expect(caught instanceof HttpException).toBe(false);
    });
  });

  // ─── Image capabilities endpoint ─────────────────────────────────────────────

  describe('GET /connectors/image/capabilities', () => {
    it('returns IMAGE_CAPABILITIES object without requiring auth', () => {
      const result = controller.getImageCapabilities();
      // Should be a non-null object
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('response has at least 4 model entries', () => {
      const result = controller.getImageCapabilities() as Record<string, unknown>;
      expect(Object.keys(result).length).toBeGreaterThanOrEqual(4);
    });

    it('each model entry has required capability fields', () => {
      const result = controller.getImageCapabilities() as Record<
        string,
        {
          modelId: string;
          provider: string;
          displayName: string;
          costPerImageUsd: number;
          latencyP95Ms: number;
        }
      >;

      for (const [modelId, cap] of Object.entries(result)) {
        expect(cap.modelId, `${modelId}.modelId`).toBe(modelId);
        expect(cap.provider, `${modelId}.provider`).toBeTruthy();
        expect(cap.displayName, `${modelId}.displayName`).toBeTruthy();
        expect(typeof cap.costPerImageUsd, `${modelId}.costPerImageUsd`).toBe('number');
        expect(cap.costPerImageUsd, `${modelId}.costPerImageUsd > 0`).toBeGreaterThan(0);
        expect(typeof cap.latencyP95Ms, `${modelId}.latencyP95Ms`).toBe('number');
      }
    });

    it('does not expose internal implementation fields (e.g. vault paths)', () => {
      const raw = JSON.stringify(controller.getImageCapabilities());
      // Vault paths must not leak into the public capabilities response
      expect(raw).not.toContain('arcanada/prod/env');
      expect(raw).not.toContain('PLACEHOLDER');
    });

    it('contains vertex, replicate, openai-images providers', () => {
      const result = controller.getImageCapabilities() as Record<string, { provider: string }>;
      const providers = new Set(Object.values(result).map((c) => c.provider));
      expect(providers).toContain('vertex');
      expect(providers).toContain('replicate');
      expect(providers).toContain('openai-images');
    });
  });
});

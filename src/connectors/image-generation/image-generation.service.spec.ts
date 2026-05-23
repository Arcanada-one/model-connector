import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { PrismaService } from '../../prisma/prisma.service';

vi.mock('@nestjs/bullmq', () => ({
  InjectQueue: () => () => {},
  BullModule: { registerQueue: vi.fn() },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn().mockResolvedValue({ id: 'bull-123' });
  },
}));

vi.mock('google-auth-library', () => {
  const MockGoogleAuth = vi.fn().mockImplementation(function (this: {
    getAccessToken: () => Promise<{ token: string }>;
  }) {
    this.getAccessToken = vi.fn().mockResolvedValue({ token: 'mock-token' });
  });
  return { GoogleAuth: MockGoogleAuth };
});

// Mock env.schema to avoid DATABASE_URL requirement
vi.mock('../../config/env.schema', () => ({
  getConfig: vi.fn().mockReturnValue({
    IMAGE_PROVIDER_VERTEX_ENABLED: false,
    IMAGE_PROVIDER_REPLICATE_ENABLED: false,
    IMAGE_PROVIDER_OPENAI_ENABLED: false,
    IMAGE_PROVIDER_CODEX_ENABLED: false,
    VERTEX_PROJECT_ID: undefined,
    VERTEX_LOCATION: 'us-central1',
    REPLICATE_API_TOKEN: undefined,
    OPENAI_API_KEY: undefined,
  }),
}));

vi.mock('./errors/provider-not-provisioned.error', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./errors/provider-not-provisioned.error')>();
  return actual;
});

import { ImageGenerationService } from './image-generation.service';
import { ProviderNotProvisionedError } from './errors/provider-not-provisioned.error';

const prismaMock = {
  imageGeneration: {
    create: vi.fn().mockResolvedValue({ id: 'gen-uuid' }),
    update: vi.fn().mockResolvedValue({}),
  },
} as unknown as PrismaService;

const queueMock = {
  add: vi.fn().mockResolvedValue({ id: 'bull-job-1' }),
} as unknown as Queue;

describe('ImageGenerationService', () => {
  let service: ImageGenerationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ImageGenerationService(prismaMock, queueMock);
  });

  describe('handleRequest — ProviderNotProvisionedError fallback', () => {
    it('propagates ProviderNotProvisionedError when all cheap providers unprovisioned', async () => {
      // Override processRequest to simulate vertex being unprovisioned
      vi.spyOn(service as never, 'processRequest').mockRejectedValue(
        new ProviderNotProvisionedError('vertex', 'arcanada/prod/env/model-connector-vertex'),
      );

      await expect(
        service.handleRequest(
          {
            tier: 'cheap',
            prompt: 'test',
            quality: 'medium',
            count: 1,
            outputFormat: 'url',
            outputAsync: 'never',
          },
          'test-api-key',
        ),
      ).rejects.toThrow(ProviderNotProvisionedError);
    });

    it('returns 503 when all providers disabled', async () => {
      // CONN-0213 D-2 regress: with every IMAGE_PROVIDER_*_ENABLED flag off
      // (see getConfig mock above), resolveConnector returns null for any
      // resolved provider — processRequest MUST throw the typed
      // ProviderNotProvisionedError carrying HTTP 503 (not generic Error 500),
      // so the controller maps it deterministically. Guards
      // image-generation.service.ts:204.
      const call = (
        service as unknown as {
          processRequest: (req: unknown, apiKeyId: string, provider: string) => Promise<unknown>;
        }
      ).processRequest(
        {
          tier: 'mid',
          prompt: 'all-providers-disabled regress',
          quality: 'medium',
          count: 1,
          outputFormat: 'url',
          outputAsync: 'never',
        },
        'test-api-key',
        'vertex',
      );

      await expect(call).rejects.toThrow(ProviderNotProvisionedError);
      await expect(call).rejects.toMatchObject({
        getStatus: expect.any(Function),
      });
      try {
        await call;
      } catch (err) {
        expect((err as ProviderNotProvisionedError).getStatus()).toBe(
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    });

    it('falls back to next provider when primary is unprovisioned', async () => {
      // First call (vertex) throws unprovisioned; second (replicate:flux-pro) succeeds
      const mockProcessRequest = vi
        .spyOn(service as never, 'processRequest')
        .mockRejectedValueOnce(
          new ProviderNotProvisionedError('vertex', 'arcanada/prod/env/model-connector-vertex'),
        )
        .mockResolvedValueOnce({
          requestId: 'fallback-result',
          status: 'completed',
          urls: ['https://example.com/image.png'],
          costUsd: 0.04,
          latencyMs: 5000,
          routing: {
            chosenProvider: 'replicate',
            chosenModel: 'replicate:flux-pro',
            fallbackUsed: true,
            reason: 'fallback',
            candidate: { modelId: 'replicate:flux-pro', providerId: 'replicate', tier: 'premium' },
            costUsd: 0.04,
          },
        });

      const result = await service.handleRequest(
        {
          tier: 'premium',
          prompt: 'test fallback',
          quality: 'high',
          count: 1,
          outputFormat: 'url',
          outputAsync: 'never',
        },
        'test-api-key',
      );

      expect(mockProcessRequest).toHaveBeenCalledTimes(2);
      expect(result.routing.chosenProvider).toBe('replicate');
    });
  });

  describe('routing_decision JSONB persistence', () => {
    it('creates ImageGeneration row with metadata containing routing decision', async () => {
      // Service has no connectors enabled (all disabled in mock getConfig)
      // We spy on prisma.imageGeneration.create to verify routing JSONB
      const createSpy = vi.spyOn(prismaMock.imageGeneration, 'create').mockResolvedValue({
        id: 'gen-routing-test',
      } as never);

      // Override processRequest to succeed immediately after DB create
      vi.spyOn(service as never, 'processRequest').mockResolvedValue({
        requestId: 'gen-routing-test',
        status: 'completed',
        urls: ['https://r2.example.com/img.png'],
        costUsd: 0.02,
        latencyMs: 1000,
        routing: {
          chosenProvider: 'vertex',
          chosenModel: 'vertex:imagen-4-fast',
          fallbackUsed: false,
          reason: 'test routing',
          candidate: { modelId: 'vertex:imagen-4-fast', providerId: 'vertex', tier: 'mid' },
          costUsd: 0.02,
        },
      });

      vi.spyOn(prismaMock.imageGeneration, 'update').mockResolvedValue({} as never);

      await service.handleRequest(
        {
          tier: 'mid',
          prompt: 'routing test',
          quality: 'medium',
          count: 1,
          outputFormat: 'url',
          outputAsync: 'never',
        },
        'test-api-key',
      );

      // Verify create was called
      expect(createSpy).toHaveBeenCalledOnce();

      // Verify metadata field contains JSON-encoded routing decision
      const createCall = createSpy.mock.calls[0][0] as { data: { metadata: string } };
      expect(createCall.data.metadata).toBeDefined();

      const metadata = JSON.parse(createCall.data.metadata) as {
        routing: { chosenProvider: string; chosenModel: string };
      };
      expect(metadata.routing).toBeDefined();
      expect(metadata.routing.chosenProvider).toBeTruthy();
      expect(metadata.routing.chosenModel).toBeTruthy();
    });

    it('update call includes costUsd and latencyMs after sync completion', async () => {
      vi.spyOn(prismaMock.imageGeneration, 'create').mockResolvedValue({
        id: 'gen-update-test',
      } as never);
      const updateSpy = vi
        .spyOn(prismaMock.imageGeneration, 'update')
        .mockResolvedValue({} as never);

      vi.spyOn(service as never, 'processRequest').mockResolvedValue({
        requestId: 'gen-update-test',
        status: 'completed',
        urls: ['https://r2.example.com/img.png'],
        costUsd: 0.04,
        latencyMs: 2500,
        routing: {
          chosenProvider: 'vertex',
          chosenModel: 'vertex:imagen-4',
          fallbackUsed: false,
          reason: 'test',
          candidate: { modelId: 'vertex:imagen-4', providerId: 'vertex', tier: 'mid' },
          costUsd: 0.04,
        },
      });

      await service.handleRequest(
        {
          tier: 'mid',
          prompt: 'update test',
          quality: 'medium',
          count: 1,
          outputFormat: 'url',
          outputAsync: 'never',
        },
        'test-api-key',
      );

      expect(updateSpy).toHaveBeenCalledOnce();
      const updateCall = updateSpy.mock.calls[0][0] as {
        data: { costUsd: number; latencyMs: number; status: string };
      };
      expect(updateCall.data.costUsd).toBe(0.04);
      expect(updateCall.data.latencyMs).toBe(2500);
      expect(updateCall.data.status).toBe('completed');
    });
  });

  describe('shouldRunAsync', () => {
    it('returns true for async-provider models', () => {
      expect(service.shouldRunAsync('vertex:imagen-4-ultra', 'auto')).toBe(true);
      expect(service.shouldRunAsync('replicate:flux-pro', 'auto')).toBe(true);
    });

    it('returns false for sync models', () => {
      expect(service.shouldRunAsync('vertex:imagen-4-fast', 'auto')).toBe(false);
      expect(service.shouldRunAsync('vertex:nano-banana', 'auto')).toBe(false);
    });

    it('force async overrides sync model', () => {
      expect(service.shouldRunAsync('vertex:imagen-4-fast', 'force')).toBe(true);
    });

    it('never async returns false even for async models', () => {
      expect(service.shouldRunAsync('vertex:imagen-4-ultra', 'never')).toBe(false);
    });
  });
});

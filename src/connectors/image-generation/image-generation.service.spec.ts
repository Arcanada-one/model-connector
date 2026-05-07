import { describe, it, expect, vi, beforeEach } from 'vitest';
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

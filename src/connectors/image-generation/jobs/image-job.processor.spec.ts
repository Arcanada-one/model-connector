import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PrismaService } from '../../../prisma/prisma.service';

// ─── Mock BullMQ ──────────────────────────────────────────────────────────────
// Per memory `feedback_redis_lua_vs_multi`: ioredis-mock too thin for Lua.
// We mock BullMQ at module level to avoid Redis dependency in unit tests.
vi.mock('@nestjs/bullmq', () => ({
  Processor: () => () => {},
  WorkerHost: class {
    process(_job: unknown): Promise<unknown> {
      return Promise.resolve(null);
    }
  },
  InjectQueue: () => () => {},
  BullModule: { registerQueue: vi.fn() },
}));

vi.mock('bullmq', () => ({
  Job: class {},
  Queue: class {
    add = vi.fn().mockResolvedValue({ id: 'bullmq-job-123' });
    getJob = vi.fn();
  },
}));

import { ImageJobProcessor, type ImageJobData } from './image-job.processor';
import type { ImageGenerationRequest, ImageGenerationResult } from '../types';
import type { IImageGenerationService } from './image-job.processor';

// ─── Mock PrismaService ───────────────────────────────────────────────────────
const prismaMock = {
  imageGeneration: {
    create: vi.fn(),
    update: vi.fn(),
    findFirst: vi.fn(),
  },
  imageJob: {
    create: vi.fn(),
    update: vi.fn(),
  },
} as unknown as PrismaService;

// ─── Mock ImageGenerationService ─────────────────────────────────────────────
const imageServiceMock: IImageGenerationService = {
  processRequest: vi.fn(),
};

describe('ImageJobProcessor', () => {
  let processor: ImageJobProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new ImageJobProcessor(prismaMock, imageServiceMock);
  });

  it('calls imageService.processRequest with job data', async () => {
    const req: ImageGenerationRequest = {
      tier: 'mid',
      prompt: 'async job test',
      quality: 'medium',
      count: 1,
      outputFormat: 'url',
      outputAsync: 'force',
    };

    const mockResult: ImageGenerationResult = {
      requestId: 'async-req-1',
      status: 'completed',
      urls: ['https://r2.example.com/img.png'],
      costUsd: 0.04,
      latencyMs: 5000,
      routing: {
        chosenProvider: 'vertex',
        chosenModel: 'vertex:imagen-4',
        fallbackUsed: false,
        reason: 'test',
      },
    };
    vi.mocked(imageServiceMock.processRequest).mockResolvedValue(mockResult);
    (prismaMock.imageGeneration.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const jobData: ImageJobData = {
      request: req,
      apiKeyId: 'key-abc',
      imageGenerationId: 'gen-uuid-1',
    };

    const mockJob = { id: 'bull-job-1', data: jobData } as unknown as Job<ImageJobData>;
    await processor.process(mockJob);

    expect(imageServiceMock.processRequest).toHaveBeenCalledWith(req, 'key-abc');
  });

  it('updates ImageGeneration status to failed on error', async () => {
    vi.mocked(imageServiceMock.processRequest).mockRejectedValue(new Error('provider timeout'));
    (prismaMock.imageGeneration.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const jobData: ImageJobData = {
      request: {
        tier: 'premium',
        prompt: 'fail',
        quality: 'high',
        count: 1,
        outputFormat: 'url',
        outputAsync: 'force',
      },
      apiKeyId: 'key-xyz',
      imageGenerationId: 'gen-fail-1',
    };

    const mockJob = { id: 'bull-job-2', data: jobData } as unknown as Job<ImageJobData>;
    await expect(processor.process(mockJob)).rejects.toThrow('provider timeout');

    expect(prismaMock.imageGeneration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'gen-fail-1' },
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});

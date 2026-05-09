import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { PrismaService } from '../../../prisma/prisma.service';

// ─── Mock NestJS + BullMQ decorators ─────────────────────────────────────────
vi.mock('@nestjs/bullmq', () => ({
  InjectQueue: () => () => {},
  BullModule: { registerQueue: vi.fn() },
}));

import { ImageJobController } from './image-job.controller';

// ─── Mock PrismaService ───────────────────────────────────────────────────────
const prismaMock = {
  imageGeneration: {
    findFirst: vi.fn(),
  },
} as unknown as PrismaService;

interface MockRequest extends FastifyRequest {
  apiKey?: { id: string };
}

describe('ImageJobController', () => {
  let controller: ImageJobController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new ImageJobController(prismaMock);
  });

  it('returns job status for valid apiKeyId ownership', async () => {
    (prismaMock.imageGeneration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'gen-123',
      status: 'processing',
      resultUrl: null,
      costUsd: 0.04,
    });

    const req = { apiKey: { id: 'key-abc' } } as MockRequest;
    const result = await controller.getJobStatus('gen-123', req);

    expect(result.status).toBe('processing');
    expect(prismaMock.imageGeneration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'gen-123',
          apiKeyId: 'key-abc',
        }),
      }),
    );
  });

  it('returns 404 when job not found or apiKeyId mismatch', async () => {
    (prismaMock.imageGeneration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const req = { apiKey: { id: 'other-key' } } as MockRequest;
    await expect(controller.getJobStatus('gen-999', req)).rejects.toThrow();
  });
});

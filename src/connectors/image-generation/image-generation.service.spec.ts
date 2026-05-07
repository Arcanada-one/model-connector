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

import { ImageGenerationService } from './image-generation.service';

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

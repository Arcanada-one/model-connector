import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  const mockPrisma = {
    $queryRaw: vi.fn(),
  };

  let controller: HealthController;

  beforeEach(() => {
    controller = new HealthController(mockPrisma as unknown as PrismaService);
    vi.clearAllMocks();
  });

  it('should return ok for health', () => {
    const result = controller.health();
    expect(result.status).toBe('ok');
    expect(result.timestamp).toBeDefined();
  });

  it('should return ready when DB is available', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ 1: 1 }]);
    const result = await controller.ready();
    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('ok');
  });

  it('should return degraded when DB is down', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    const result = await controller.ready();
    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe('error');
  });
});

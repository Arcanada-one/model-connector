import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { ConnectorsService } from '../connectors/connectors.service';

describe('HealthController', () => {
  const mockPrisma = {
    $queryRaw: vi.fn(),
  };
  const mockMetrics = {
    record: vi.fn(),
    getAll: vi.fn().mockReturnValue({ test: { totalRequests: 5, successCount: 4 } }),
  };
  const mockConnectors = {
    listNames: vi.fn().mockReturnValue(['claude-code', 'cursor']),
    getStatus: vi.fn(),
    get: vi.fn(),
  };

  let controller: HealthController;

  beforeEach(() => {
    controller = new HealthController(
      mockPrisma as unknown as PrismaService,
      mockMetrics as unknown as MetricsService,
      mockConnectors as unknown as ConnectorsService,
    );
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

  it('should return metrics from /health/metrics', () => {
    mockMetrics.getAll.mockReturnValue({
      test: { totalRequests: 10, circuitOpenCount: 2, queueTimeoutCount: 1 },
    });
    const result = controller.metrics();
    expect(result).toHaveProperty('test');
    expect(result.test.circuitOpenCount).toBe(2);
    expect(result.test.queueTimeoutCount).toBe(1);
  });

  it('should return all connectors with ok status when all healthy', async () => {
    mockConnectors.listNames.mockReturnValue(['claude-code', 'cursor']);
    mockConnectors.getStatus.mockResolvedValue({
      name: 'claude-code',
      healthy: true,
      activeJobs: 0,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
      circuitBreaker: { state: 'closed', consecutiveFailures: 0, lastErrorType: null },
    });
    mockConnectors.get.mockReturnValue({ type: 'cli' });

    const result = await controller.connectorHealth();
    expect(result.status).toBe('ok');
    expect(result.connectors).toHaveLength(2);
    expect(result.connectors[0].circuitBreaker.lastErrorType).toBeNull();
  });

  it('should return degraded when any connector is unhealthy', async () => {
    mockConnectors.listNames.mockReturnValue(['claude-code']);
    mockConnectors.getStatus.mockResolvedValue({
      name: 'claude-code',
      healthy: false,
      activeJobs: 0,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
      circuitBreaker: {
        state: 'open',
        consecutiveFailures: 5,
        lastErrorType: 'auth_error',
        nextRetryAt: Date.now() + 30000,
      },
    });
    mockConnectors.get.mockReturnValue({ type: 'cli' });

    const result = await controller.connectorHealth();
    expect(result.status).toBe('degraded');
    expect(result.connectors[0].circuitBreaker.lastErrorType).toBe('auth_error');
  });

  it('should handle getStatus failure gracefully', async () => {
    mockConnectors.listNames.mockReturnValue(['broken']);
    mockConnectors.getStatus.mockRejectedValue(new Error('probe failed'));
    mockConnectors.get.mockReturnValue({ type: 'cli' });

    const result = await controller.connectorHealth();
    expect(result.status).toBe('degraded');
    expect(result.connectors[0].healthy).toBe(false);
  });
});

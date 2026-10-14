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
    getProviderCredentialStatus: vi.fn().mockReturnValue([]),
    checkProviderCredentials: vi.fn().mockResolvedValue([]),
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

  const mockReply = () => ({ statusCode: 200 });

  it('should return ok for health', async () => {
    const reply = mockReply();
    const result = await controller.health(reply as never);
    expect(result.status).toBe('ok');
    expect(result.timestamp).toBeDefined();
    expect(reply.statusCode).toBe(200);
  });

  // A2-228: without this, a client measuring through the service cannot tell which build answered
  // it — which is how A2-221 recorded 36 calls against a month-old binary and said only which
  // address it had called.
  it('names the build it was made from, or says it cannot', async () => {
    const result = await controller.health(mockReply() as never);
    expect(result.build).toBeDefined();
    expect(result.build).toHaveProperty('sha');
    expect(result.build).toHaveProperty('source');
  });

  it('should return ready when DB is available', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ 1: 1 }]);
    const reply = mockReply();
    const result = await controller.ready(reply as never);
    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('ok');
    expect(reply.statusCode).toBe(200);
  });

  it('should return degraded when DB is down', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    const result = await controller.ready(mockReply() as never);
    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe('error');
  });

  it('keeps liveness ok and reports optional providers without credentials', async () => {
    mockConnectors.getProviderCredentialStatus.mockReturnValue([
      { connector: 'openrouter', required: false, state: 'missing' },
    ]);
    const reply = mockReply();

    const result = await controller.health(reply as never);

    expect(result.status).toBe('ok');
    expect(result.providers[0].connector).toBe('openrouter');
    expect(reply.statusCode).toBe(200);
  });

  it('keeps process liveness HTTP 200 when the required DeepSeek credential is missing', async () => {
    mockConnectors.getProviderCredentialStatus.mockReturnValue([
      { connector: 'deepseek', required: true, state: 'missing' },
    ]);
    const reply = mockReply();

    const result = await controller.health(reply as never);

    expect(result.status).toBe('ok');
    expect(result.providers[0].state).toBe('missing');
    expect(reply.statusCode).toBe(200);
  });

  it('probes providers and fails readiness for a non-ready required provider', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ 1: 1 }]);
    mockConnectors.checkProviderCredentials.mockResolvedValue([]);
    mockConnectors.getProviderCredentialStatus.mockReturnValue([
      { connector: 'openrouter', required: false, state: 'missing' },
      { connector: 'deepseek', required: true, state: 'ready' },
    ]);
    const reply = mockReply();

    const result = await controller.ready(reply as never);

    expect(result.status).toBe('degraded');
    expect(reply.statusCode).toBe(200);
    expect(mockConnectors.checkProviderCredentials).toHaveBeenCalledTimes(1);

    mockConnectors.getProviderCredentialStatus.mockReturnValue([
      { connector: 'deepseek', required: true, state: 'rejected' },
    ]);
    const failedReply = mockReply();
    const failed = await controller.ready(failedReply as never);
    expect(failed.status).toBe('error');
    expect(failedReply.statusCode).toBe(503);

    mockConnectors.getProviderCredentialStatus.mockReturnValue([
      { connector: 'deepseek', required: true, state: 'unavailable' },
    ]);
    const unavailableReply = mockReply();
    const unavailable = await controller.ready(unavailableReply as never);
    expect(unavailable.status).toBe('error');
    expect(unavailable.checks.requiredProviders).toBe('error');
    expect(unavailableReply.statusCode).toBe(503);
  });

  it('keeps liveness HTTP 200 and reports a transient provider state without source details', async () => {
    mockConnectors.getProviderCredentialStatus.mockReturnValue([
      {
        connector: 'deepseek',
        required: true,
        state: 'unavailable',
        source: 'internal-only-source',
        checkedAt: '2026-10-14T00:00:00.000Z',
      },
    ]);
    const reply = mockReply();

    const result = await controller.health(reply as never);

    expect(result.status).toBe('ok');
    expect(reply.statusCode).toBe(200);
    expect(result.providers[0].state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('internal-only-source');
  });

  it('degrades optional transient provider failures without failing HTTP', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ 1: 1 }]);
    mockConnectors.getProviderCredentialStatus.mockReturnValue([
      {
        connector: 'openrouter',
        required: false,
        state: 'unavailable',
        checkedAt: '2026-10-14T00:00:00.000Z',
      },
    ]);
    const reply = mockReply();

    const result = await controller.ready(reply as never);

    expect(result.status).toBe('degraded');
    expect(result.checks.requiredProviders).toBe('ok');
    expect(result.checks.optionalProviders).toBe('error');
    expect(reply.statusCode).toBe(200);
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
    // ConnectorStatus.circuitBreaker is optional, so prove it was reported
    // before reading through it.
    const breaker = result.connectors[0].circuitBreaker;
    expect(breaker).toBeDefined();
    expect(breaker!.lastErrorType).toBeNull();
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
    const breaker = result.connectors[0].circuitBreaker;
    expect(breaker).toBeDefined();
    expect(breaker!.lastErrorType).toBe('auth_error');
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

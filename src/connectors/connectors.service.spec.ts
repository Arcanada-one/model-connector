import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Queue } from 'bullmq';
import { ConnectorsService } from './connectors.service';
import { NotFoundException } from '@nestjs/common';
import { IConnector } from './interfaces/connector.interface';
import { PrismaService } from '../prisma/prisma.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';

describe('ConnectorsService', () => {
  let service: ConnectorsService;
  const mockQueue = { add: vi.fn() };
  const mockPrisma = { request: { create: vi.fn().mockResolvedValue({}) } };
  const mockMetrics = { record: vi.fn(), getAll: vi.fn().mockReturnValue({}) };

  const mockConnector: IConnector = {
    name: 'test',
    type: 'cli',
    execute: vi.fn().mockResolvedValue({
      id: 'resp-1',
      connector: 'test',
      model: 'model',
      result: 'ok',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 },
      latencyMs: 50,
      status: 'success',
    }),
    getStatus: vi.fn().mockResolvedValue({
      name: 'test',
      healthy: true,
      activeJobs: 0,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
    }),
    getCapabilities: vi.fn().mockReturnValue({
      name: 'test',
      type: 'cli',
      models: [],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300000,
    }),
  };

  beforeEach(() => {
    service = new ConnectorsService(
      mockQueue as unknown as Queue,
      mockPrisma as unknown as PrismaService,
      mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
      new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
    );
    vi.clearAllMocks();
  });

  it('should register and get a connector', () => {
    service.register(mockConnector);
    expect(service.get('test')).toBe(mockConnector);
  });

  it('should throw NotFoundException for unknown connector', () => {
    expect(() => service.get('nonexistent')).toThrow(NotFoundException);
  });

  it('should list connector names', () => {
    service.register(mockConnector);
    expect(service.listNames()).toEqual(['test']);
  });

  it('should execute via connector directly', async () => {
    service.register(mockConnector);
    const result = await service.execute('test', { prompt: 'hello' }, 'key-1');
    expect(result.status).toBe('success');
    expect(mockConnector.execute).toHaveBeenCalledOnce();
  });

  it('should return status for registered connector', async () => {
    service.register(mockConnector);
    const status = await service.getStatus('test');
    expect(status.name).toBe('test');
    expect(status.healthy).toBe(true);
  });

  it('should list all connectors with capabilities', async () => {
    service.register(mockConnector);
    const list = await service.listAll();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('test');
  });

  describe('retry logic', () => {
    it('should retry on json_parse_error and succeed on second attempt', async () => {
      const retryConnector: IConnector = {
        ...mockConnector,
        name: 'test',
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'r1',
            connector: 'test',
            model: 'model',
            result: 'not-json',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 },
            latencyMs: 50,
            status: 'success',
          })
          .mockResolvedValueOnce({
            id: 'r2',
            connector: 'test',
            model: 'model',
            result: '{"key": "value"}',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 },
            latencyMs: 50,
            status: 'success',
          }),
      };

      service.register(retryConnector);
      const result = await service.execute(
        'test',
        { prompt: 'hello', responseFormat: { type: 'json_object' } },
        'key-1',
      );

      expect(retryConnector.execute).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('success');
      expect(result.attempt).toBe(2);
      expect(result.structured).toEqual({ key: 'value' });
    });

    it('should not retry on auth_error', async () => {
      const authErrorConnector: IConnector = {
        ...mockConnector,
        name: 'test',
        execute: vi.fn().mockResolvedValue({
          id: 'r1',
          connector: 'test',
          model: 'model',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 50,
          status: 'error',
          error: {
            type: 'auth_error',
            message: 'Not logged in',
            retryable: false,
            recommendation: 'reauth',
          },
        }),
      };

      service.register(authErrorConnector);
      const result = await service.execute('test', { prompt: 'hello' }, 'key-1');

      expect(authErrorConnector.execute).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('error');
      expect(result.attempt).toBe(1);
      expect(result.error?.type).toBe('auth_error');
    });

    it('should respect maxAttempts limit', async () => {
      const failConnector: IConnector = {
        ...mockConnector,
        name: 'test',
        execute: vi.fn().mockResolvedValue({
          id: 'r1',
          connector: 'test',
          model: 'model',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 50,
          status: 'error',
          error: {
            type: 'timeout',
            message: 'timed out',
            retryable: true,
            recommendation: 'retry',
          },
        }),
      };

      service.register(failConnector);
      const result = await service.execute('test', { prompt: 'hello' }, 'key-1');

      // CONNECTOR_MAX_RETRIES defaults to 1, so max 2 attempts
      expect(failConnector.execute).toHaveBeenCalledTimes(2);
      expect(result.attempt).toBe(2);
      expect(result.maxAttempts).toBe(2);
      expect(result.status).toBe('error');
    });

    it('should apply JSON sanitization to successful response', async () => {
      service.register(mockConnector);
      vi.mocked(mockConnector.execute).mockResolvedValueOnce({
        id: 'r1',
        connector: 'test',
        model: 'model',
        result: '```json\n{"sanitized": true}\n```',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 },
        latencyMs: 50,
        status: 'success',
      });

      const result = await service.execute(
        'test',
        { prompt: 'hello', responseFormat: { type: 'json_object' } },
        'key-1',
      );

      expect(result.status).toBe('success');
      expect(result.structured).toEqual({ sanitized: true });
      expect(result.result).toBe('{"sanitized": true}');
    });
  });

  // CONN-0089 ------------------------------------------------------------------
  describe('output-guard integration (CONN-0089)', () => {
    function jsonConnector(result: string): IConnector {
      return {
        ...mockConnector,
        execute: vi.fn().mockResolvedValue({
          id: 'r-og',
          connector: 'test',
          model: 'model',
          result,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
          latencyMs: 10,
          status: 'success',
        }),
      } as IConnector;
    }

    it('omits repair_report when output_format is absent (V-AC-3 byte-compat)', async () => {
      service.register(mockConnector);
      const result = await service.execute('test', { prompt: 'hello' }, 'key-1');
      expect(result.repair_report).toBeUndefined();
    });

    it('attaches repair_report when output_format=json (V-AC-2)', async () => {
      const conn = jsonConnector('{"name":"x","value":1}');
      service.register(conn);
      const result = await service.execute(
        'test',
        {
          prompt: 'hello',
          output_format: 'json',
          schema: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'number' } },
            required: ['name', 'value'],
          },
        },
        'key-1',
      );
      expect(result.repair_report).toBeDefined();
      expect(result.repair_report?.final_valid).toBe(true);
    });

    it('does NOT outer-retry on guard_exhausted (orthogonality)', async () => {
      const conn = jsonConnector('this is "text" with stuff'); // forces ParseError chain
      service.register(conn);
      const result = await service.execute(
        'test',
        {
          prompt: 'hello',
          output_format: 'json',
          schema: { type: 'object', required: ['x'] },
        },
        'key-1',
      );
      expect(result.repair_report?.pass).toBe('failed');
      expect(result.error?.type).toBe('guard_exhausted');
      // Middleware itself calls connector.execute (maxRetries+1) times. Outer
      // ConnectorsService retry loop must NOT add another call on top.
      // Default OUTPUT_GUARD_MAX_RETRIES=3 → 4 calls. CONNECTOR_MAX_RETRIES=1
      // would add another 4 calls if outer retry kicked in (we'd see ≥5).
      expect((conn.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(4);
    });
  });
});

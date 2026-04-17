import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectorsService } from './connectors.service';
import { NotFoundException } from '@nestjs/common';
import { IConnector } from './interfaces/connector.interface';

describe('ConnectorsService', () => {
  let service: ConnectorsService;
  const mockQueue = { add: vi.fn() };
  const mockPrisma = { request: { create: vi.fn().mockResolvedValue({}) } };

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
    getStatus: vi.fn().mockResolvedValue({ name: 'test', healthy: true, activeJobs: 0, queuedJobs: 0, rateLimitStatus: 'ok' }),
    getCapabilities: vi.fn().mockReturnValue({ name: 'test', type: 'cli', models: [], supportsStreaming: false, supportsJsonSchema: false, supportsTools: false, maxTimeout: 300000 }),
  };

  beforeEach(() => {
    service = new ConnectorsService(mockQueue as any, mockPrisma as any);
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
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectorJobProcessor } from './connector-job.processor';
import { IConnector, ConnectorResponse } from '../connectors/interfaces/connector.interface';

describe('ConnectorJobProcessor', () => {
  const mockPrisma = {
    request: { create: vi.fn().mockResolvedValue({}) },
  };

  let processor: ConnectorJobProcessor;

  beforeEach(() => {
    processor = new ConnectorJobProcessor(mockPrisma as any);
    vi.clearAllMocks();
  });

  it('should process job and log to DB', async () => {
    const mockResponse: ConnectorResponse = {
      id: 'test-id',
      connector: 'test',
      model: 'gpt-4',
      result: 'hello',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 },
      latencyMs: 100,
      status: 'success',
    };

    const mockConnector: IConnector = {
      name: 'test',
      type: 'cli',
      execute: vi.fn().mockResolvedValue(mockResponse),
      getStatus: vi.fn(),
      getCapabilities: vi.fn(),
    };

    processor.registerConnector(mockConnector);

    const job = {
      id: 'job-1',
      data: {
        connectorName: 'test',
        request: { prompt: 'hello' },
        apiKeyId: 'key-1',
      },
    };

    const result = await processor.process(job as any);
    expect(result.status).toBe('success');
    expect(result.result).toBe('hello');
    expect(mockPrisma.request.create).toHaveBeenCalledOnce();
  });
});

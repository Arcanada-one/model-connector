import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';

describe('ConnectorsController', () => {
  const mockService = {
    listAll: vi.fn().mockResolvedValue([{ name: 'test', type: 'cli', capabilities: {} }]),
    getStatus: vi.fn().mockResolvedValue({ name: 'test', healthy: true }),
    execute: vi.fn().mockResolvedValue({ id: '1', status: 'success', result: 'ok' }),
  };

  let controller: ConnectorsController;

  beforeEach(() => {
    controller = new ConnectorsController(mockService as unknown as ConnectorsService);
    vi.clearAllMocks();
  });

  it('should list connectors', async () => {
    const result = await controller.listConnectors();
    expect(result).toHaveLength(1);
    expect(mockService.listAll).toHaveBeenCalledOnce();
  });

  it('should get connector status', async () => {
    const result = await controller.getStatus('test');
    expect(result.healthy).toBe(true);
    expect(mockService.getStatus).toHaveBeenCalledWith('test');
  });

  it('should execute per-connector', async () => {
    const req = { apiKey: { id: 'key-1' } };
    const result = await controller.executePerConnector('test', { prompt: 'hi' }, req);
    expect(result.status).toBe('success');
    expect(mockService.execute).toHaveBeenCalledWith('test', { prompt: 'hi' }, 'key-1');
  });

  it('should execute universal', async () => {
    const req = { apiKey: { id: 'key-1' } };
    const result = await controller.executeUniversal({ connector: 'test', prompt: 'hi' }, req);
    expect(result.status).toBe('success');
    expect(mockService.execute).toHaveBeenCalledWith('test', { prompt: 'hi' }, 'key-1');
  });
});

// CONN-0243 — FailoverRouterService unit tests (mock ConnectorsService).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FailoverRouterService } from './failover-router.service';
import { FailoverExhaustedError } from './failover.errors';
import { ConnectorCapabilities, ConnectorResponse } from '../interfaces/connector.interface';

vi.mock('../../config/env.schema', () => ({ getConfig: vi.fn(() => ({})) }));

function caps(name: string, model: string, free: boolean): ConnectorCapabilities {
  return {
    name,
    type: 'api',
    models: [model],
    supportsStreaming: false,
    supportsJsonSchema: true,
    supportsTools: false,
    maxTimeout: 120_000,
    freeModels: free ? [model] : [],
    modelMeta: [{ id: model, free, modality: 'chat' }],
  };
}

function success(connector: string, model: string): ConnectorResponse {
  return {
    id: 'r',
    connector,
    model,
    result: 'hello',
    usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: 0 },
    latencyMs: 12,
    status: 'success',
  };
}

function rateLimited(connector: string, model: string): ConnectorResponse {
  return {
    id: 'r',
    connector,
    model,
    result: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    latencyMs: 5,
    status: 'error',
    error: { type: 'rate_limited', message: '429', retryable: true, recommendation: 'wait' },
  };
}

const CAPS = [
  caps('openmodel', 'deepseek-v4-flash', true),
  caps('groq', 'llama-3.3-70b-versatile', true),
];

function makeService(execImpl: (connector: string) => Promise<ConnectorResponse>) {
  const execute = vi.fn((connector: string) => execImpl(connector));
  const mockConnectors = {
    listCapabilities: vi.fn(() => CAPS),
    execute,
  };
  const service = new FailoverRouterService(
    mockConnectors as unknown as ConstructorParameters<typeof FailoverRouterService>[0],
  );
  return { service, execute };
}

describe('FailoverRouterService.complete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AC2: first provider 429 → a DIFFERENT provider serves the completion', async () => {
    const { service, execute } = makeService((connector) =>
      connector === 'openmodel'
        ? Promise.resolve(rateLimited('openmodel', 'deepseek-v4-flash'))
        : Promise.resolve(success('groq', 'llama-3.3-70b-versatile')),
    );

    const res = await service.complete({ prompt: 'ping' }, 'key-1', { requestedModel: 'auto' });

    expect(res.status).toBe('success');
    expect(res.connector).toBe('groq');
    expect(res.connector).not.toBe('openmodel');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('passes maxRetries:0 to the inner execute (R-F1, no compounded backoff)', async () => {
    const { service, execute } = makeService(() =>
      Promise.resolve(success('openmodel', 'deepseek-v4-flash')),
    );
    await service.complete({ prompt: 'ping' }, 'key-1');
    expect(execute).toHaveBeenCalledWith(
      'openmodel',
      expect.objectContaining({ maxRetries: 0 }),
      'key-1',
    );
  });

  it('free-first: DeepSeek (openmodel) is tried before groq', async () => {
    const order: string[] = [];
    const { service } = makeService((connector) => {
      order.push(connector);
      return Promise.resolve(rateLimited(connector, 'x'));
    });
    await expect(service.complete({ prompt: 'ping' }, 'k')).rejects.toThrow(FailoverExhaustedError);
    expect(order[0]).toBe('openmodel');
    expect(order[1]).toBe('groq');
  });

  it('all providers 429 → FailoverExhaustedError', async () => {
    const { service } = makeService((c) => Promise.resolve(rateLimited(c, 'x')));
    await expect(service.complete({ prompt: 'ping' }, 'k')).rejects.toThrow(FailoverExhaustedError);
  });
});

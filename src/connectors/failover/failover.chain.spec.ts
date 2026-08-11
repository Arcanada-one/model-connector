// CONN-0243 — pure failover chain unit tests (mirror cascade T1/T2/T4/T5/T7).

import { describe, it, expect, vi } from 'vitest';
import { runFailoverChain } from './failover.chain';
import { FailoverExhaustedError, FailoverAbortError } from './failover.errors';
import { CascadeCandidate } from '../cascade/cascade.profiles';
import { ConnectorResponse } from '../interfaces/connector.interface';

function success(connector: string, model: string): ConnectorResponse {
  return {
    id: 'resp',
    connector,
    model,
    result: 'ok',
    usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, costUsd: 0 },
    latencyMs: 10,
    status: 'success',
  };
}

function err(
  connector: string,
  model: string,
  errorType: string,
  retryable = true,
): ConnectorResponse {
  return {
    id: 'resp',
    connector,
    model,
    result: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    latencyMs: 5,
    status: 'error',
    error: {
      type: errorType,
      message: `sim ${errorType}`,
      retryable,
      recommendation: retryable ? 'retry' : 'abort',
    },
  };
}

const CANDIDATES: CascadeCandidate[] = [
  { connector: 'openmodel', model: 'deepseek-v4-flash', tier: 'free' },
  { connector: 'groq', model: 'llama-3.3-70b-versatile', tier: 'free' },
  { connector: 'openrouter', model: 'deepseek-v4-flash', tier: 'paid' },
];

function chainWith(responses: ConnectorResponse[]) {
  let idx = 0;
  const execute = vi.fn(() => Promise.resolve(responses[idx++] ?? err('x', 'y', 'server_error')));
  return { execute };
}

describe('runFailoverChain', () => {
  it('T1: first free candidate succeeds → returns it, one call', async () => {
    const { execute } = chainWith([success('openmodel', 'deepseek-v4-flash')]);
    const res = await runFailoverChain({
      candidates: CANDIDATES,
      execute,
      request: { prompt: 'ping' },
      apiKeyId: 'k1',
    });
    expect(res.status).toBe('success');
    expect(res.connector).toBe('openmodel');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('T2: first 429 → second free candidate (DIFFERENT provider) serves [DoD AC2]', async () => {
    const { execute } = chainWith([
      err('openmodel', 'deepseek-v4-flash', 'rate_limited'),
      success('groq', 'llama-3.3-70b-versatile'),
    ]);
    const res = await runFailoverChain({
      candidates: CANDIDATES,
      execute,
      request: { prompt: 'ping' },
      apiKeyId: 'k1',
    });
    expect(res.status).toBe('success');
    expect(res.connector).toBe('groq');
    expect(res.connector).not.toBe('openmodel');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('T4: all candidates rate_limited → FailoverExhaustedError', async () => {
    const { execute } = chainWith([
      err('openmodel', 'deepseek-v4-flash', 'rate_limited'),
      err('groq', 'llama-3.3-70b-versatile', 'rate_limited'),
      err('openrouter', 'deepseek-v4-flash', 'rate_limited'),
    ]);
    await expect(
      runFailoverChain({
        candidates: CANDIDATES,
        execute,
        request: { prompt: 'ping' },
        apiKeyId: 'k1',
      }),
    ).rejects.toThrow(FailoverExhaustedError);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('T5: circuit_open advances (not abort) → later candidate serves', async () => {
    const { execute } = chainWith([
      err('openmodel', 'deepseek-v4-flash', 'circuit_open', false),
      success('groq', 'llama-3.3-70b-versatile'),
    ]);
    const res = await runFailoverChain({
      candidates: CANDIDATES,
      execute,
      request: { prompt: 'ping' },
      apiKeyId: 'k1',
    });
    expect(res.connector).toBe('groq');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('T7: abort-class error (validation_error) → FailoverAbortError, stops immediately', async () => {
    const { execute } = chainWith([
      err('openmodel', 'deepseek-v4-flash', 'validation_error', false),
    ]);
    await expect(
      runFailoverChain({
        candidates: CANDIDATES,
        execute,
        request: { prompt: 'ping' },
        apiKeyId: 'k1',
      }),
    ).rejects.toMatchObject({
      name: 'FailoverAbortError',
      errorType: 'validation_error',
      connector: 'openmodel',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('T7b: abort-class FailoverAbortError is the thrown type (not Exhausted)', async () => {
    const { execute } = chainWith([err('groq', 'm', 'auth_error', false)]);
    await expect(
      runFailoverChain({
        candidates: CANDIDATES,
        execute,
        request: { prompt: 'x' },
        apiKeyId: 'k',
      }),
    ).rejects.toBeInstanceOf(FailoverAbortError);
  });

  it('connector throw → advance to next candidate', async () => {
    let idx = 0;
    const execute = vi.fn(() => {
      idx++;
      if (idx === 1) return Promise.reject(new Error('connector not found'));
      return Promise.resolve(success('groq', 'llama-3.3-70b-versatile'));
    });
    const res = await runFailoverChain({
      candidates: CANDIDATES,
      execute,
      request: { prompt: 'ping' },
      apiKeyId: 'k1',
    });
    expect(res.connector).toBe('groq');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('empty candidate list → FailoverExhaustedError', async () => {
    const { execute } = chainWith([]);
    await expect(
      runFailoverChain({ candidates: [], execute, request: { prompt: 'x' }, apiKeyId: 'k' }),
    ).rejects.toThrow(FailoverExhaustedError);
    expect(execute).not.toHaveBeenCalled();
  });
});

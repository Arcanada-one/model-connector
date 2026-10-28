// CONN-0243 — pure failover chain unit tests (mirror cascade T1/T2/T4/T5/T7).

import { describe, it, expect, vi } from 'vitest';
import { runFailoverChain, ChainHopSignals } from './failover.chain';
import { FailoverExhaustedError, FailoverAbortError, ChainDeadlineError } from './failover.errors';
import { CascadeCandidate } from '../cascade/cascade.profiles';
import { classifyErrorAction, ConnectorResponse } from '../interfaces/connector.interface';

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

  it('timeout on an API hop advances to the next candidate', async () => {
    const hanging = err('openmodel', 'deepseek-v4-flash', 'timeout', false);
    hanging.status = 'timeout';
    const { execute } = chainWith([hanging, success('groq', 'llama-3.3-70b-versatile')]);
    const res = await runFailoverChain({
      candidates: CANDIDATES,
      execute,
      request: { prompt: 'ping' },
      apiKeyId: 'k1',
    });
    expect(res.status).toBe('success');
    expect(res.connector).toBe('groq');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('caps each hop at min(its timeout, remaining chain budget)', async () => {
    let t = 0;
    const execute = vi.fn((_connector: string, req: { timeout?: number }) => {
      if (execute.mock.calls.length === 1) {
        expect(req.timeout).toBe(30_000);
        t = 20_000;
        const hanging = err('openmodel', 'deepseek-v4-flash', 'timeout', false);
        hanging.status = 'timeout';
        return Promise.resolve(hanging);
      }
      expect(req.timeout).toBe(10_000);
      return Promise.resolve(success('groq', 'llama-3.3-70b-versatile'));
    });
    const res = await runFailoverChain({
      candidates: CANDIDATES,
      execute,
      request: { prompt: 'ping', timeout: 80_000 },
      apiKeyId: 'k1',
      deadlineMs: 30_000,
      now: () => t,
    });
    expect(res.connector).toBe('groq');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('deadline exhausted returns the last hop error and does not start another hop', async () => {
    let t = 0;
    const execute = vi.fn(() => {
      t = 5_000;
      const hanging = err('openmodel', 'deepseek-v4-flash', 'timeout', false);
      hanging.status = 'timeout';
      return Promise.resolve(hanging);
    });
    const error = await runFailoverChain({
      candidates: CANDIDATES,
      execute,
      request: { prompt: 'ping' },
      apiKeyId: 'k1',
      deadlineMs: 5_000,
      now: () => t,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChainDeadlineError);
    expect(error).toMatchObject({
      name: 'ChainDeadlineError',
      type: 'chain_deadline_exceeded',
      lastHop: {
        connector: 'openmodel',
        model: 'deepseek-v4-flash',
        errorType: 'timeout',
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a stall after the first streamed chunk does not advance', async () => {
    const execute = vi.fn(
      (_connector: string, _req: unknown, _key: string, hop?: ChainHopSignals) => {
        hop?.noteChunkSent();
        const hanging = err('openmodel', 'deepseek-v4-flash', 'timeout', false);
        hanging.status = 'timeout';
        return Promise.resolve(hanging);
      },
    );
    await expect(
      runFailoverChain({
        candidates: CANDIDATES,
        execute,
        request: { prompt: 'ping' },
        apiKeyId: 'k1',
      }),
    ).rejects.toMatchObject({
      name: 'FailoverAbortError',
      errorType: 'timeout',
      connector: 'openmodel',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a response marked clientChunkSent does not advance', async () => {
    const hanging = err('openmodel', 'deepseek-v4-flash', 'timeout', false);
    hanging.status = 'timeout';
    (hanging as { clientChunkSent?: boolean }).clientChunkSent = true;
    const { execute } = chainWith([hanging, success('groq', 'llama-3.3-70b-versatile')]);
    await expect(
      runFailoverChain({
        candidates: CANDIDATES,
        execute,
        request: { prompt: 'ping' },
        apiKeyId: 'k1',
      }),
    ).rejects.toBeInstanceOf(FailoverAbortError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a CLI hop timeout does not advance (tools may already have run)', async () => {
    const hanging = err('gemini', 'gemini-2.5-flash', 'timeout', false);
    hanging.status = 'timeout';
    const execute = vi.fn(() => Promise.resolve(hanging));
    await expect(
      runFailoverChain({
        candidates: [
          { connector: 'gemini', model: 'gemini-2.5-flash', tier: 'free' },
          { connector: 'groq', model: 'llama-3.3-70b-versatile', tier: 'free' },
        ],
        execute,
        request: { prompt: 'ping' },
        apiKeyId: 'k1',
        allowTimeoutAdvance: () => false,
      }),
    ).rejects.toBeInstanceOf(FailoverAbortError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('direct-caller timeout classification stays abort', () => {
    expect(classifyErrorAction('timeout')).toEqual({
      retryable: false,
      recommendation: 'abort',
    });
    expect(classifyErrorAction('queue_timeout')).toEqual({
      retryable: true,
      recommendation: 'wait',
    });
  });

  it('empty candidate list → FailoverExhaustedError', async () => {
    const { execute } = chainWith([]);
    await expect(
      runFailoverChain({ candidates: [], execute, request: { prompt: 'x' }, apiKeyId: 'k' }),
    ).rejects.toThrow(FailoverExhaustedError);
    expect(execute).not.toHaveBeenCalled();
  });
});

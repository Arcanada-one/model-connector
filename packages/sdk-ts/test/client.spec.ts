import { describe, expect, it } from 'vitest';
import { Client, ConnectorError, GuardExhaustedError, TimeoutError, redactCause } from '../src/index.js';
import type { ExecuteRequest, ExecuteResponse, RepairReport } from '../src/index.js';

const API_KEY = '<MODEL_CONNECTOR_API_KEY>';
const BASE_URL = 'https://mc.test.local';

function makeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): typeof globalThis.fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(typeof url === 'string' ? url : url.toString(), init ?? {}))) as typeof globalThis.fetch;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const baseRequest: ExecuteRequest = {
  connector: 'openrouter',
  prompt: 'ping',
  model: 'mistralai/mistral-small-3.2-24b-instruct',
};

describe('Client', () => {
  it('parses HTTP 201 success envelope', async () => {
    const expected: ExecuteResponse = {
      id: 'run_1',
      connector: 'openrouter',
      model: 'mistralai/mistral-small-3.2-24b-instruct',
      result: 'pong',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.0001 },
      latencyMs: 412,
      status: 'success',
    };
    const client = new Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: makeFetch(() => jsonResponse(201, expected)),
    });
    const got = await client.execute(baseRequest);
    expect(got).toEqual(expected);
  });

  it('attaches repair_report on output_format=json native pass', async () => {
    const report: RepairReport = {
      strategies_applied: [],
      retries: 0,
      final_valid: true,
      pass: 'native',
    };
    const client = new Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: makeFetch(() =>
        jsonResponse(201, {
          id: 'run_2',
          connector: 'openrouter',
          model: 'm',
          result: '{}',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 100,
          status: 'success',
          repair_report: report,
        }),
      ),
    });
    const got = await client.execute({ ...baseRequest, output_format: 'json' });
    expect(got.repair_report).toEqual(report);
  });

  it('reports guarded pass with strategies applied', async () => {
    const client = new Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: makeFetch(() =>
        jsonResponse(201, {
          id: 'run_3',
          connector: 'openrouter',
          model: 'm',
          result: '{"ok":true}',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 200,
          status: 'success',
          repair_report: {
            strategies_applied: ['strip_fences', 'trailing_comma'],
            retries: 1,
            final_valid: true,
            pass: 'guarded',
          },
        }),
      ),
    });
    const got = await client.execute({ ...baseRequest, output_format: 'json', schema: { type: 'object' } });
    expect(got.repair_report?.pass).toBe('guarded');
    expect(got.repair_report?.retries).toBe(1);
    expect(got.repair_report?.strategies_applied).toHaveLength(2);
  });

  it('throws GuardExhaustedError on guard_exhausted', async () => {
    const client = new Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: makeFetch(() =>
        jsonResponse(500, {
          error: {
            type: 'guard_exhausted',
            message: 'max retries exhausted',
            retryable: false,
            recommendation: 'abort',
          },
        }),
      ),
    });
    await expect(client.execute({ ...baseRequest, output_format: 'json' })).rejects.toBeInstanceOf(
      GuardExhaustedError,
    );
  });

  it('maps 401 auth_error to ConnectorError', async () => {
    const client = new Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: makeFetch(() =>
        jsonResponse(401, {
          error: {
            type: 'auth_error',
            message: 'invalid api key',
            retryable: false,
            recommendation: 'reauth',
          },
        }),
      ),
    });
    await expect(client.execute(baseRequest)).rejects.toMatchObject({
      name: 'ConnectorError',
      status: 401,
      envelope: { type: 'auth_error' },
    });
  });

  it('propagates Retry-After header on 429', async () => {
    const client = new Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: makeFetch(() =>
        jsonResponse(
          429,
          { error: { type: 'rate_limited', message: 'slow down', retryable: true, recommendation: 'wait' } },
          { 'retry-after': '10' },
        ),
      ),
    });
    await expect(client.execute(baseRequest)).rejects.toMatchObject({ retryAfter: 10 });
  });

  it('classifies 5xx as ConnectorError with retryable envelope', async () => {
    const client = new Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: makeFetch(() =>
        jsonResponse(503, {
          error: { type: 'server_error', message: 'upstream down', retryable: true, recommendation: 'retry' },
        }),
      ),
    });
    await expect(client.execute(baseRequest)).rejects.toMatchObject({
      envelope: { retryable: true, type: 'server_error' },
    });
  });

  it('throws TimeoutError when AbortSignal fires', async () => {
    const client = new Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      timeoutMs: 5,
      fetch: makeFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal as AbortSignal | undefined;
            signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      ),
    });
    await expect(client.execute(baseRequest)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('wraps network errors with ConnectorError network_error envelope', async () => {
    const client = new Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: makeFetch(() => Promise.reject(new TypeError('fetch failed'))),
    });
    await expect(client.execute(baseRequest)).rejects.toMatchObject({
      name: 'ConnectorError',
      status: 0,
      envelope: { type: 'network_error', retryable: true },
    });
  });

  it('redacts Bearer token from error.cause', async () => {
    const client = new Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: makeFetch(() =>
        jsonResponse(400, {
          error: { type: 'validation_error', message: 'bad request', retryable: false, recommendation: 'abort' },
          echoedHeader: `Bearer ${API_KEY}`,
          authorization: `Bearer ${API_KEY}`,
        }),
      ),
    });
    try {
      await client.execute(baseRequest);
      throw new Error('unreachable');
    } catch (e) {
      const cause = (e as Error & { cause?: unknown }).cause;
      const serialized = JSON.stringify(cause);
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).toContain('[REDACTED]');
    }
  });

  it('redactCause walker scrubs nested authorization headers', () => {
    const result = redactCause({
      level1: {
        headers: { Authorization: `Bearer ${API_KEY}`, 'x-trace': 'abc' },
        body: `note: Bearer ${API_KEY} was sent`,
      },
    }) as { level1: { headers: { Authorization: string }; body: string } };
    expect(result.level1.headers.Authorization).toBe('[REDACTED]');
    expect(result.level1.body).toContain('[REDACTED]');
    expect(result.level1.body).not.toContain(API_KEY);
  });

  it('rejects ctor without apiKey', () => {
    expect(() => new Client({ apiKey: '' } as unknown as { apiKey: string })).toThrow();
  });
});

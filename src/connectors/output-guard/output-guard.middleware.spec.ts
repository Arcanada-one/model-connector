// CONN-0089 — OutputGuardMiddleware unit spec.
// Stub IConnector instances drive the validate-and-repair pipeline without
// hitting any real provider.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  IConnector,
} from '../interfaces/connector.interface';
import { OutputGuardMiddleware, type OutputGuardRuntimeConfig } from './output-guard.middleware';

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, value: { type: 'number' } },
  required: ['name', 'value'],
  additionalProperties: false,
};

function makeCaps(over: Partial<ConnectorCapabilities> = {}): ConnectorCapabilities {
  return {
    name: 'openrouter',
    type: 'api',
    models: ['m'],
    supportsStreaming: false,
    supportsJsonSchema: true,
    supportsTools: false,
    maxTimeout: 60_000,
    ...over,
  };
}

function makeResponse(over: Partial<ConnectorResponse> = {}): ConnectorResponse {
  return {
    id: 'resp-1',
    connector: 'openrouter',
    model: 'm',
    result: '{}',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
    latencyMs: 10,
    status: 'success',
    ...over,
  };
}

function stubConnector(opts: {
  capabilities?: Partial<ConnectorCapabilities>;
  responses: Array<Partial<ConnectorResponse>>;
}): IConnector & { execute: ReturnType<typeof vi.fn>; lastRequest: () => ConnectorRequest } {
  let last: ConnectorRequest | undefined;
  let i = 0;
  const execute = vi.fn(async (req: ConnectorRequest) => {
    last = req;
    const resp = opts.responses[Math.min(i, opts.responses.length - 1)];
    i++;
    return makeResponse(resp);
  });
  return {
    name: opts.capabilities?.name ?? 'openrouter',
    type: opts.capabilities?.type ?? 'api',
    execute,
    getCapabilities: () => makeCaps(opts.capabilities),
    getStatus: async () => ({
      name: 'openrouter',
      healthy: true,
      activeJobs: 0,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
    }),
    resetCircuitBreaker: () => [],
    lastRequest: () => last as ConnectorRequest,
  };
}

function makeMiddleware(cfg: Partial<OutputGuardRuntimeConfig> = {}): OutputGuardMiddleware {
  return new OutputGuardMiddleware({
    enabled: true,
    maxRetries: 3,
    timeoutMs: 30_000,
    ...cfg,
  });
}

describe('OutputGuardMiddleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bypasses when env-kill-switch (OUTPUT_GUARD_ENABLED=false)', async () => {
    const mw = makeMiddleware({ enabled: false });
    const conn = stubConnector({ responses: [{ result: 'raw text' }] });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(out.bypassed).toBe(true);
    expect(out.report).toBeNull();
    expect(out.response.result).toBe('raw text');
  });

  it('bypasses when output_format is absent (backward-compat)', async () => {
    const mw = makeMiddleware();
    const conn = stubConnector({ responses: [{ result: 'anything' }] });
    const out = await mw.wrapExecute(conn, { prompt: 'p' });
    expect(out.bypassed).toBe(true);
    expect(out.response.result).toBe('anything');
  });

  it('strips guard-only fields from the request handed to the connector', async () => {
    const mw = makeMiddleware();
    const conn = stubConnector({ responses: [{ result: '{"name":"x","value":1}' }] });
    await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
      // @ts-expect-error — confirm guard fields are stripped
      stray: 'ignored',
    });
    const reqSeen = conn.lastRequest() as Record<string, unknown>;
    expect(reqSeen.output_format).toBeUndefined();
    expect(reqSeen.schema).toBeUndefined();
  });

  it('marks pass=native when first response is clean + supportsJsonSchema=true', async () => {
    const mw = makeMiddleware();
    const conn = stubConnector({
      capabilities: { name: 'openrouter', supportsJsonSchema: true },
      responses: [{ result: '{"name":"x","value":1}' }],
    });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(out.report?.pass).toBe('native');
    expect(out.report?.final_valid).toBe(true);
    expect(out.report?.retries).toBe(0);
    expect(out.report?.strategies_applied).toEqual([]);
    expect(out.response.structured).toEqual({ name: 'x', value: 1 });
  });

  it('marks pass=guarded when strategies were applied on the first attempt', async () => {
    const mw = makeMiddleware();
    const fenced = '```json\n{"name":"x","value":1}\n```';
    const conn = stubConnector({
      responses: [{ result: fenced }],
    });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(out.report?.final_valid).toBe(true);
    expect(out.report?.pass).toBe('guarded');
    expect(out.report?.strategies_applied.length).toBeGreaterThan(0);
    expect(out.report?.retries).toBe(0);
  });

  it('repairs trailing commas', async () => {
    const mw = makeMiddleware();
    const conn = stubConnector({
      responses: [{ result: '{"name":"x","value":1,}' }],
    });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(out.report?.final_valid).toBe(true);
    expect(out.response.structured).toEqual({ name: 'x', value: 1 });
  });

  it('marks pass=guarded when CLI fallback connector succeeds (supportsJsonSchema=false)', async () => {
    const mw = makeMiddleware();
    const conn = stubConnector({
      capabilities: { name: 'claude-code', type: 'cli', supportsJsonSchema: false },
      responses: [{ result: '{"name":"x","value":1}' }],
    });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(out.report?.pass).toBe('guarded');
    expect(out.report?.final_valid).toBe(true);
  });

  it('appends schema instruction to systemPrompt for CLI connectors', async () => {
    const mw = makeMiddleware();
    const conn = stubConnector({
      capabilities: { name: 'claude-code', type: 'cli', supportsJsonSchema: false },
      responses: [{ result: '{"name":"x","value":1}' }],
    });
    await mw.wrapExecute(conn, {
      prompt: 'p',
      systemPrompt: 'prior',
      output_format: 'json',
      schema: SCHEMA,
    });
    const seen = conn.lastRequest();
    expect(seen.systemPrompt).toContain('prior');
    expect(seen.systemPrompt).toContain('schema');
  });

  it('exhausts retries on irrecoverable garbage → pass=failed + guard_exhausted', async () => {
    const mw = makeMiddleware({ maxRetries: 2 });
    const conn = stubConnector({
      responses: [{ result: 'no json here at all' }],
    });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(out.report?.final_valid).toBe(false);
    expect(out.report?.pass).toBe('failed');
    expect(out.response.status).toBe('error');
    expect(out.response.error?.type).toBe('guard_exhausted');
    expect(out.response.error?.retryable).toBe(false);
    expect(out.response.error?.recommendation).toBe('abort');
  });

  it('honours maxRetries by issuing exactly N+1 connector calls when always failing', async () => {
    const mw = makeMiddleware({ maxRetries: 2 });
    const conn = stubConnector({
      responses: [{ result: 'garbage' }, { result: 'garbage' }, { result: 'garbage' }],
    });
    await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(conn.execute).toHaveBeenCalledTimes(3);
  });

  it('rebuilds the prompt via retryPrompt between attempts', async () => {
    const mw = makeMiddleware({ maxRetries: 1 });
    const conn = stubConnector({
      responses: [{ result: 'garbage' }, { result: '{"name":"x","value":1}' }],
    });
    await mw.wrapExecute(conn, {
      prompt: 'original',
      output_format: 'json',
      schema: SCHEMA,
    });
    const secondPrompt = conn.execute.mock.calls[1][0].prompt as string;
    expect(secondPrompt).not.toBe('original');
    expect(secondPrompt.length).toBeGreaterThan(0);
  });

  it('passes connector transport-level errors through without repair', async () => {
    const mw = makeMiddleware();
    const conn = stubConnector({
      responses: [
        {
          result: '',
          status: 'error',
          error: {
            type: 'rate_limited',
            message: 'slow down',
            retryable: true,
            recommendation: 'wait',
          },
        },
      ],
    });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(out.report).toBeNull();
    expect(out.response.status).toBe('error');
    expect(out.response.error?.type).toBe('rate_limited');
    expect(conn.execute).toHaveBeenCalledTimes(1);
  });

  it('short-circuits with validation_error when the schema fails ajv compile', async () => {
    const mw = makeMiddleware();
    const conn = stubConnector({ responses: [{ result: '{"x":1}' }] });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      // Invalid: unknown keyword + invalid type definition
      schema: { type: 'not-a-real-type' },
    });
    expect(out.response.status).toBe('error');
    expect(out.response.error?.type).toBe('validation_error');
    expect(out.report?.pass).toBe('failed');
    expect(conn.execute).toHaveBeenCalledTimes(0);
  });

  it('marks pass=failed when repair succeeds but schema validation rejects', async () => {
    const mw = makeMiddleware({ maxRetries: 0 });
    const conn = stubConnector({
      // Valid JSON, but wrong shape: missing required `value`.
      responses: [{ result: '{"name":"x"}' }],
    });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(out.report?.final_valid).toBe(false);
    expect(out.report?.pass).toBe('failed');
    expect(out.response.error?.type).toBe('guard_exhausted');
  });

  it('records retries=2 when third attempt finally succeeds', async () => {
    const mw = makeMiddleware({ maxRetries: 3 });
    const conn = stubConnector({
      responses: [
        { result: 'no json' },
        { result: 'still no json' },
        { result: '{"name":"x","value":1}' },
      ],
    });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(out.report?.final_valid).toBe(true);
    expect(out.report?.retries).toBe(2);
    expect(out.report?.pass).toBe('guarded');
  });

  it('uses default config when none injected', async () => {
    // Constructor-without-config defaults: enabled=true, maxRetries=3
    const mw = new OutputGuardMiddleware();
    const conn = stubConnector({ responses: [{ result: '{"name":"x","value":1}' }] });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
      schema: SCHEMA,
    });
    expect(out.bypassed).toBe(false);
    expect(out.report?.final_valid).toBe(true);
  });

  it('accepts output_format without schema (format-only repair)', async () => {
    const mw = makeMiddleware();
    const conn = stubConnector({
      responses: [{ result: '```json\n{"a":1}\n```' }],
    });
    const out = await mw.wrapExecute(conn, {
      prompt: 'p',
      output_format: 'json',
    });
    expect(out.report?.final_valid).toBe(true);
    expect(out.response.structured).toEqual({ a: 1 });
  });
});

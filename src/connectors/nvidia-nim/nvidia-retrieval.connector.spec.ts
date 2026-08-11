import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  NvidiaRetrievalConfigurationError,
  NvidiaRetrievalConnector,
  type NvidiaRetrievalConfig,
  type NvidiaRetrievalTransport,
  type NvidiaRetrievalTransportRequest,
  type NvidiaRetrievalTransportResponse,
} from './nvidia-retrieval.connector';

const HOSTED_KEY = 'synthetic-secret-CONN-0287';
const HOSTED_EMBED_MODEL = 'nvidia/nemotron-3-embed-1b';
const HOSTED_RERANK_MODEL = 'nvidia/llama-nemotron-rerank-1b-v2';
const SELF_EMBED_MODEL = 'self-hosted-embed-synthetic';
const SELF_RERANK_MODEL = 'self-hosted-rerank-synthetic';

interface SyntheticFixture<T> {
  fixture: {
    provenance: string;
    task: string;
    source_shape: string;
  };
  response: T;
}

function fixture<T>(name: string): SyntheticFixture<T> {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
  return JSON.parse(raw) as SyntheticFixture<T>;
}

const embeddingFixture = fixture<Record<string, unknown>>('embedding-success.synthetic.json');
const rerankFixture = fixture<Record<string, unknown>>('rerank-success.synthetic.json');
const modelsFixture = fixture<Record<string, unknown>>('models-success.synthetic.json');
const errorFixture = fixture<Record<string, unknown>>('provider-error.synthetic.json');

function hostedConfig(): NvidiaRetrievalConfig {
  return {
    deployment: { mode: 'hosted', apiKey: HOSTED_KEY },
    embeddingModel: HOSTED_EMBED_MODEL,
    rerankModel: HOSTED_RERANK_MODEL,
    timeoutMs: 5_000,
  };
}

function selfHostedConfig(): NvidiaRetrievalConfig {
  return {
    deployment: {
      mode: 'self-hosted',
      baseUrl: 'https://nim.synthetic.example/prefix/',
      auth: { type: 'header', name: 'X-Synthetic-Auth', value: HOSTED_KEY },
    },
    embeddingModel: SELF_EMBED_MODEL,
    rerankModel: SELF_RERANK_MODEL,
    timeoutMs: 5_000,
  };
}

function transportWith(
  ...responses: Array<NvidiaRetrievalTransportResponse | Error>
): NvidiaRetrievalTransport & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) send.mockRejectedValueOnce(response);
    else send.mockResolvedValueOnce(response);
  }
  return { send };
}

function ok(body: unknown): NvidiaRetrievalTransportResponse {
  return { status: 200, body };
}

function sent(transport: { send: ReturnType<typeof vi.fn> }): NvidiaRetrievalTransportRequest {
  return transport.send.mock.calls[0][0] as NvidiaRetrievalTransportRequest;
}

describe('CONN-0287 synthetic fixture provenance', () => {
  it.each([
    embeddingFixture,
    rerankFixture,
    modelsFixture,
    errorFixture,
  ])('labels every response as handwritten and never captured', (entry) => {
    expect(entry.fixture.task).toBe('CONN-0287');
    expect(entry.fixture.provenance).toContain('handwritten deterministic synthetic');
    expect(entry.fixture.provenance).toContain('never captured');
    expect(entry.fixture.source_shape).toContain('accessed 2026-07-19');
  });

  it('documents the non-capture policy next to the fixtures', () => {
    const provenance = readFileSync(join(__dirname, '__fixtures__', 'README.md'), 'utf8');
    expect(provenance).toContain('None is a capture');
    expect(provenance).toContain('public first-party NVIDIA');
  });
});

describe('NvidiaRetrievalConnector configuration', () => {
  it.each([
    [{ ...hostedConfig(), deployment: { mode: 'hosted', apiKey: '' } }],
    [{ ...hostedConfig(), embeddingModel: 'nvidia/unsupported-embed' }],
    [{ ...hostedConfig(), rerankModel: 'nvidia/unsupported-rerank' }],
    [
      {
        ...selfHostedConfig(),
        deployment: {
          mode: 'self-hosted',
          baseUrl: 'https://user:password@nim.synthetic.example',
          auth: { type: 'none' },
        },
      },
    ],
    [
      {
        ...selfHostedConfig(),
        deployment: {
          mode: 'self-hosted',
          baseUrl: 'file:///tmp/nim',
          auth: { type: 'none' },
        },
      },
    ],
    [
      {
        ...selfHostedConfig(),
        deployment: {
          mode: 'self-hosted',
          baseUrl: 'https://nim.synthetic.example?route=other',
          auth: { type: 'none' },
        },
      },
    ],
    [
      {
        ...selfHostedConfig(),
        deployment: {
          mode: 'self-hosted',
          baseUrl: 'https://nim.synthetic.example',
          auth: { type: 'header', name: 'Authorization', value: HOSTED_KEY },
        },
      },
    ],
    [
      {
        ...selfHostedConfig(),
        deployment: {
          mode: 'self-hosted',
          baseUrl: 'https://nim.synthetic.example',
          auth: { type: 'header', name: 'X-Test', value: 'bad\r\nvalue' },
        },
      },
    ],
  ])('fails closed for invalid or invented deployment configuration', (config) => {
    expect(() => new NvidiaRetrievalConnector(config as NvidiaRetrievalConfig, transportWith())).toThrow(
      NvidiaRetrievalConfigurationError,
    );
  });

  it('copies configuration so later caller mutation cannot change routes or auth', async () => {
    const config = selfHostedConfig();
    const transport = transportWith(ok(embeddingFixture.response));
    const connector = new NvidiaRetrievalConnector(config, transport);
    if (config.deployment.mode !== 'self-hosted') throw new Error('test setup mismatch');
    config.deployment.baseUrl = 'https://mutated.invalid';
    config.deployment.auth = { type: 'none' };

    await connector.execute({
      prompt: 'synthetic query',
      extra: { operation: 'embeddings', inputType: 'query' },
    });

    expect(sent(transport).url).toBe('https://nim.synthetic.example/prefix/v1/embeddings');
    expect(sent(transport).headers['X-Synthetic-Auth']).toBe(HOSTED_KEY);
  });
});

describe('hosted NVIDIA retrieval routing', () => {
  it('routes embeddings to the exact HTTPS origin with Bearer auth and an allowlisted body', async () => {
    const transport = transportWith(ok(embeddingFixture.response));
    const connector = new NvidiaRetrievalConnector(hostedConfig(), transport);

    const response = await connector.execute({
      prompt: 'ignored compatibility prompt',
      model: HOSTED_EMBED_MODEL,
      extra: {
        operation: 'embeddings',
        input: ['synthetic query', 'synthetic passage'],
        inputType: 'query',
        encodingFormat: 'float',
        truncate: 'END',
        user: 'must-not-pass',
        __proto__: { polluted: true },
      },
    });

    expect(sent(transport)).toEqual({
      method: 'POST',
      url: 'https://integrate.api.nvidia.com/v1/embeddings',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${HOSTED_KEY}`,
      },
      body: {
        model: HOSTED_EMBED_MODEL,
        input: ['synthetic query', 'synthetic passage'],
        input_type: 'query',
        encoding_format: 'float',
        truncate: 'END',
      },
      timeoutMs: 5_000,
    });
    expect(response.status).toBe('success');
    expect(response.model).toBe(HOSTED_EMBED_MODEL);
    expect(response.structured).toEqual({
      operation: 'embeddings',
      data: (embeddingFixture.response.data as unknown[]).map((entry) => ({
        object: (entry as Record<string, unknown>).object,
        index: (entry as Record<string, unknown>).index,
        embedding: (entry as Record<string, unknown>).embedding,
      })),
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
    expect(response.usage).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      totalTokens: 7,
      costUsd: 0,
    });
    expect(Object.getPrototypeOf(sent(transport).body)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain('must-not-cross-normalization');
  });

  it('routes reranking to the exact researched model-specific URL', async () => {
    const transport = transportWith(ok(rerankFixture.response));
    const connector = new NvidiaRetrievalConnector(hostedConfig(), transport);

    const response = await connector.execute({
      prompt: 'synthetic query',
      model: HOSTED_RERANK_MODEL,
      extra: {
        operation: 'rerank',
        passages: ['synthetic first', 'synthetic second'],
        truncate: 'NONE',
        topN: 1,
      },
    });

    expect(sent(transport).url).toBe(
      'https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-nemotron-rerank-1b-v2/reranking',
    );
    expect(sent(transport).body).toEqual({
      model: HOSTED_RERANK_MODEL,
      query: { text: 'synthetic query' },
      passages: [{ text: 'synthetic first' }, { text: 'synthetic second' }],
      truncate: 'NONE',
    });
    expect(response.structured).toEqual({
      operation: 'rerank',
      rankings: [
        { index: 1, logit: 3.25 },
        { index: 0, logit: -0.5 },
      ],
      usage: { prompt_tokens: 11, total_tokens: 11 },
    });
  });

  it('enforces the hosted 1000-passage bound before transport', async () => {
    const transport = transportWith();
    const connector = new NvidiaRetrievalConnector(hostedConfig(), transport);
    const response = await connector.execute({
      prompt: 'query',
      extra: { operation: 'rerank', passages: Array.from({ length: 1001 }, () => 'passage') },
    });
    expect(response.error?.type).toBe('validation_error');
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe('self-hosted NVIDIA retrieval routing', () => {
  it('uses documented relative embedding and ranking paths without hosted Bearer invention', async () => {
    const transport = transportWith(
      ok(embeddingFixture.response),
      ok(rerankFixture.response),
    );
    const connector = new NvidiaRetrievalConnector(selfHostedConfig(), transport);

    await connector.execute({
      prompt: 'synthetic passage',
      extra: { operation: 'embeddings', inputType: 'passage' },
    });
    await connector.execute({
      prompt: 'synthetic query',
      extra: { operation: 'rerank', passages: ['first', 'second'], truncate: 'END' },
    });

    expect(transport.send.mock.calls.map((call) => call[0].url)).toEqual([
      'https://nim.synthetic.example/prefix/v1/embeddings',
      'https://nim.synthetic.example/prefix/v1/ranking',
    ]);
    expect(transport.send.mock.calls[0][0].headers).toEqual({
      'Content-Type': 'application/json',
      'X-Synthetic-Auth': HOSTED_KEY,
    });
    expect(transport.send.mock.calls[0][0].headers.Authorization).toBeUndefined();
  });

  it('supports explicit none and Bearer operator auth policies', async () => {
    const noneTransport = transportWith(ok(embeddingFixture.response));
    const noneConfig = selfHostedConfig();
    if (noneConfig.deployment.mode !== 'self-hosted') throw new Error('test setup mismatch');
    noneConfig.deployment.auth = { type: 'none' };
    await new NvidiaRetrievalConnector(noneConfig, noneTransport).execute({
      prompt: 'query',
      extra: { operation: 'embeddings', inputType: 'query' },
    });
    expect(sent(noneTransport).headers).toEqual({ 'Content-Type': 'application/json' });

    const bearerTransport = transportWith(ok(embeddingFixture.response));
    const bearerConfig = selfHostedConfig();
    if (bearerConfig.deployment.mode !== 'self-hosted') throw new Error('test setup mismatch');
    bearerConfig.deployment.auth = { type: 'bearer', token: HOSTED_KEY };
    await new NvidiaRetrievalConnector(bearerConfig, bearerTransport).execute({
      prompt: 'query',
      extra: { operation: 'embeddings', inputType: 'query' },
    });
    expect(sent(bearerTransport).headers.Authorization).toBe(`Bearer ${HOSTED_KEY}`);
  });

  it('enforces the self-hosted 512-passage bound before transport', async () => {
    const transport = transportWith();
    const connector = new NvidiaRetrievalConnector(selfHostedConfig(), transport);
    const response = await connector.execute({
      prompt: 'query',
      extra: { operation: 'rerank', passages: Array.from({ length: 513 }, () => 'passage') },
    });
    expect(response.error?.type).toBe('validation_error');
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe('discovery, readiness, and capabilities', () => {
  it('keeps hosted discovery configured-only and does not invent a health request', async () => {
    const transport = transportWith();
    const connector = new NvidiaRetrievalConnector(hostedConfig(), transport);

    await expect(connector.discoverModels()).resolves.toEqual({
      source: 'configured',
      models: [HOSTED_EMBED_MODEL, HOSTED_RERANK_MODEL],
    });
    await expect(connector.getStatus()).resolves.toMatchObject({
      name: 'nvidia-retrieval',
      healthy: false,
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('uses only documented self-hosted model and readiness paths', async () => {
    const transport = transportWith(ok(modelsFixture.response), ok({ status: 'ready' }));
    const connector = new NvidiaRetrievalConnector(selfHostedConfig(), transport);

    await expect(connector.discoverModels()).resolves.toEqual({
      source: 'runtime',
      models: [SELF_EMBED_MODEL, SELF_RERANK_MODEL],
    });
    await expect(connector.getStatus()).resolves.toMatchObject({
      name: 'nvidia-retrieval',
      healthy: true,
    });
    expect(transport.send.mock.calls.map((call) => call[0])).toMatchObject([
      { method: 'GET', url: 'https://nim.synthetic.example/prefix/v1/models' },
      { method: 'GET', url: 'https://nim.synthetic.example/prefix/v1/health/ready' },
    ]);
  });

  it('advertises only configured retrieval operations and deployment-specific facts', () => {
    const hosted = new NvidiaRetrievalConnector(hostedConfig(), transportWith());
    expect(hosted.getCapabilities()).toMatchObject({
      name: 'nvidia-retrieval',
      type: 'api',
      models: [HOSTED_EMBED_MODEL, HOSTED_RERANK_MODEL],
      modelMeta: [
        { id: HOSTED_EMBED_MODEL, modality: 'embedding' },
        { id: HOSTED_RERANK_MODEL, modality: 'rerank' },
      ],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
    });
    expect(hosted.getDeploymentInfo()).toEqual({
      mode: 'hosted',
      authentication: 'nvidia-bearer',
      discovery: 'configured-only',
      health: 'unavailable',
      geography: 'model-pages-global-not-universal',
      lifecycle: 'provider-release-notes-no-universal-sla',
      maxRerankPassages: 1000,
    });
  });
});

describe('fail-closed validation and response parsing', () => {
  it.each([
    { prompt: 'x', extra: { operation: 'unknown' } },
    { prompt: 'x', model: HOSTED_RERANK_MODEL, extra: { operation: 'embeddings', inputType: 'query' } },
    { prompt: '', extra: { operation: 'embeddings', inputType: 'query' } },
    { prompt: 'x', extra: { operation: 'embeddings', inputType: 'other' } },
    { prompt: 'x', extra: { operation: 'embeddings', inputType: 'query', truncate: 'MIDDLE' } },
    { prompt: 'x', extra: { operation: 'rerank', passages: [] } },
    { prompt: 'x', extra: { operation: 'rerank', passages: [''] } },
    { prompt: 'x', extra: { operation: 'rerank', passages: ['x'], truncate: 'START' } },
    { prompt: 'x', timeout: 10, extra: { operation: 'embeddings', inputType: 'query' } },
  ])('rejects invalid requests without calling transport', async (request) => {
    const transport = transportWith();
    const response = await new NvidiaRetrievalConnector(hostedConfig(), transport).execute(request);
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('validation_error');
    expect(transport.send).not.toHaveBeenCalled();
  });

  it.each([
    [{ data: [], model: HOSTED_EMBED_MODEL }],
    [{ data: [{ object: 'embedding', index: 0, embedding: [0.1, Number.NaN] }], model: HOSTED_EMBED_MODEL }],
    [{ data: [{ object: 'embedding', index: 0, embedding: [0.1] }, { object: 'embedding', index: 0, embedding: [0.2] }], model: HOSTED_EMBED_MODEL }],
    [{ rankings: [{ index: 0, logit: 1 }, { index: 0, logit: 0.5 }] }],
    [{ rankings: [{ index: 9, logit: 1 }] }],
    [{ rankings: [{ index: 0, logit: Number.POSITIVE_INFINITY }] }],
  ])('turns malformed synthetic success into parse_error', async (body) => {
    const transport = transportWith(ok(body));
    const operation = 'rankings' in body ? 'rerank' : 'embeddings';
    const response = await new NvidiaRetrievalConnector(hostedConfig(), transport).execute(
      operation === 'rerank'
        ? { prompt: 'q', extra: { operation, passages: ['one', 'two'] } }
        : { prompt: 'q', extra: { operation, inputType: 'query' } },
    );
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('parse_error');
    expect(response.error?.message).not.toContain(HOSTED_KEY);
  });

  it('does not invent usage units when the provider omits usage', async () => {
    const body = structuredClone(embeddingFixture.response);
    delete body.usage;
    const connector = new NvidiaRetrievalConnector(hostedConfig(), transportWith(ok(body)));
    const response = await connector.execute({
      prompt: 'query',
      extra: { operation: 'embeddings', input: ['query', 'passage'], inputType: 'query' },
    });
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
    expect(response.structured).not.toHaveProperty('usage');
  });

  it('strips secret-bearing unknown fields from a valid success', async () => {
    const body = structuredClone(embeddingFixture.response);
    body.debug = { credential: HOSTED_KEY };
    const connector = new NvidiaRetrievalConnector(hostedConfig(), transportWith(ok(body)));
    const response = await connector.execute({
      prompt: 'query',
      extra: { operation: 'embeddings', input: ['query', 'passage'], inputType: 'query' },
    });
    expect(response.status).toBe('success');
    expect(JSON.stringify(response)).not.toContain(HOSTED_KEY);
  });

  it('does not traverse or leak cyclic and deep malformed-success payloads', async () => {
    const body: Record<string, unknown> = {
      object: 'list',
      model: HOSTED_EMBED_MODEL,
      data: { deep: { nested: { credential: HOSTED_KEY } } },
    };
    body.self = body;
    const connector = new NvidiaRetrievalConnector(hostedConfig(), transportWith(ok(body)));
    const response = await connector.execute({
      prompt: 'query',
      extra: { operation: 'embeddings', inputType: 'query' },
    });
    expect(response.error?.type).toBe('parse_error');
    expect(JSON.stringify(response)).not.toContain(HOSTED_KEY);
  });
});

describe('HTTP, timeout, and bounded redaction', () => {
  it.each([
    [400, 'validation_error'],
    [401, 'auth_error'],
    [403, 'auth_error'],
    [402, 'billing_error'],
    [404, 'model_not_found'],
    [408, 'timeout'],
    [422, 'validation_error'],
    [429, 'rate_limited'],
    [500, 'server_error'],
  ])('classifies HTTP %i as %s', async (status, expected) => {
    const connector = new NvidiaRetrievalConnector(
      hostedConfig(),
      transportWith({ status, body: { error: { message: 'synthetic provider error' } } }),
    );
    const response = await connector.execute({
      prompt: 'query',
      extra: { operation: 'embeddings', inputType: 'query' },
    });
    expect(response.error?.type).toBe(expected);
  });

  it('redacts credentials and control characters from documented error fields', async () => {
    const connector = new NvidiaRetrievalConnector(
      hostedConfig(),
      transportWith({ status: 401, body: errorFixture.response }),
    );
    const response = await connector.execute({
      prompt: 'query',
      extra: { operation: 'embeddings', inputType: 'query' },
    });
    expect(response.error?.message).toContain('[REDACTED]');
    expect(response.error?.message).not.toContain(HOSTED_KEY);
    expect(response.error?.message).not.toMatch(/[\r\n\t]/);
  });

  it('handles cyclic and deeply nested error payloads without traversal or leakage', async () => {
    const cyclic: Record<string, unknown> = { message: 'safe synthetic summary' };
    cyclic.self = cyclic;
    cyclic.deep = { nested: { credential: HOSTED_KEY } };
    const connector = new NvidiaRetrievalConnector(
      hostedConfig(),
      transportWith({ status: 500, body: cyclic }),
    );
    const response = await connector.execute({
      prompt: 'query',
      extra: { operation: 'embeddings', inputType: 'query' },
    });
    expect(response.error?.message).toBe('safe synthetic summary');
    expect(JSON.stringify(response)).not.toContain(HOSTED_KEY);
  });

  it('normalizes AbortError without reflecting the thrown secret-bearing message', async () => {
    const abort = new Error(`request aborted ${HOSTED_KEY}`);
    abort.name = 'AbortError';
    const connector = new NvidiaRetrievalConnector(hostedConfig(), transportWith(abort));
    const response = await connector.execute({
      prompt: 'query',
      extra: { operation: 'embeddings', inputType: 'query' },
    });
    expect(response.status).toBe('timeout');
    expect(response.error?.type).toBe('timeout');
    expect(response.error?.message).not.toContain(HOSTED_KEY);
  });
});

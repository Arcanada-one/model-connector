import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PineconeInferenceConnector } from './pinecone-inference.connector';

const FIXTURE_ROOT = resolve(
  __dirname,
  '../../..',
  'test/fixtures/connectors/pinecone-inference',
);

const readSyntheticFixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(FIXTURE_ROOT, name), 'utf8')) as unknown;

const embedDense = readSyntheticFixture('embed-dense.synthetic.json');
const embedSparse = readSyntheticFixture('embed-sparse.synthetic.json');
const rerank = readSyntheticFixture('rerank.synthetic.json');

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('PineconeInferenceConnector', () => {
  let connector: PineconeInferenceConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.PINECONE_API_KEY = 'synthetic-test-key';
    connector = new PineconeInferenceConnector();
    connector.setSemaphore(1);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.PINECONE_API_KEY;
  });

  it('declares one API connector without speculative model metadata', () => {
    expect(connector.name).toBe('pinecone-inference');
    expect(connector.getCapabilities()).toEqual({
      name: 'pinecone-inference',
      type: 'api',
      models: [],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 120_000,
    });
  });

  it('posts an allowlisted embedding request to the hosted Inference endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(embedDense));

    const response = await connector.execute({
      prompt: 'repository transport placeholder',
      model: 'synthetic-dense-model',
      extra: {
        operation: 'embed',
        inputs: [{ text: 'alpha' }, { text: 'beta' }],
        parameters: { input_type: 'passage', truncate: 'END' },
        namespace: 'must-not-leak',
        vectors: [{ id: 'must-not-leak' }],
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.pinecone.io/embed');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'Api-Key': 'synthetic-test-key',
      'X-Pinecone-Api-Version': '2026-04',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'synthetic-dense-model',
      inputs: [{ text: 'alpha' }, { text: 'beta' }],
      parameters: { input_type: 'passage', truncate: 'END' },
    });
    expect(String(init.body)).not.toContain('namespace');
    expect(String(init.body)).not.toContain('vectors');
    expect(String(init.body)).not.toContain('repository transport placeholder');
    expect(response.status).toBe('success');
  });

  it('posts an allowlisted rerank request to the hosted Inference endpoint', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(rerank));

    await connector.execute({
      prompt: 'repository transport placeholder',
      model: 'synthetic-rerank-model',
      extra: {
        operation: 'rerank',
        query: 'synthetic query',
        documents: [
          { id: 'synthetic-doc-a', text: 'Synthetic alpha text.' },
          { id: 'synthetic-doc-b', text: 'Synthetic beta text.' },
        ],
        top_n: 2,
        return_documents: true,
        rank_fields: ['text'],
        parameters: { truncate: 'END' },
        index_name: 'must-not-leak',
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.pinecone.io/rerank');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'Api-Key': 'synthetic-test-key',
      'X-Pinecone-Api-Version': '2026-04',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'synthetic-rerank-model',
      query: 'synthetic query',
      documents: [
        { id: 'synthetic-doc-a', text: 'Synthetic alpha text.' },
        { id: 'synthetic-doc-b', text: 'Synthetic beta text.' },
      ],
      top_n: 2,
      return_documents: true,
      rank_fields: ['text'],
      parameters: { truncate: 'END' },
    });
    expect(String(init.body)).not.toContain('index_name');
  });

  it('preserves a dense embedding response and maps token usage', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(embedDense));
    const response = await connector.execute({
      prompt: 'unused',
      model: 'synthetic-dense-model',
      extra: { operation: 'embed', inputs: [{ text: 'alpha' }] },
    });

    expect(response.structured).toEqual(embedDense);
    expect(response.result).toBe('');
    expect(response.usage).toEqual({
      inputTokens: 9,
      outputTokens: 0,
      totalTokens: 9,
      costUsd: 0,
    });
  });

  it('preserves a sparse embedding response without dense conversion', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(embedSparse));
    const response = await connector.execute({
      prompt: 'unused',
      model: 'synthetic-sparse-model',
      extra: { operation: 'embed', inputs: [{ text: 'alpha' }] },
    });

    expect(response.structured).toEqual(embedSparse);
    expect(response.usage.inputTokens).toBe(4);
  });

  it('preserves rerank units without misreporting them as tokens', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(rerank));
    const response = await connector.execute({
      prompt: 'unused',
      model: 'synthetic-rerank-model',
      extra: {
        operation: 'rerank',
        query: 'query',
        documents: [{ text: 'document' }],
      },
    });

    expect(response.structured).toEqual(rerank);
    expect(response.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    });
  });

  it.each([
    ['missing operation', { model: 'm', extra: { inputs: [{ text: 'x' }] } }],
    ['unknown operation', { model: 'm', extra: { operation: 'search' } }],
    ['missing model', { extra: { operation: 'embed', inputs: [{ text: 'x' }] } }],
    ['empty embed inputs', { model: 'm', extra: { operation: 'embed', inputs: [] } }],
    [
      'invalid embed input',
      { model: 'm', extra: { operation: 'embed', inputs: [{ text: '' }] } },
    ],
    [
      'missing rerank query',
      { model: 'm', extra: { operation: 'rerank', documents: [{ text: 'x' }] } },
    ],
    [
      'empty rerank documents',
      { model: 'm', extra: { operation: 'rerank', query: 'q', documents: [] } },
    ],
    [
      'invalid top_n',
      {
        model: 'm',
        extra: { operation: 'rerank', query: 'q', documents: [{ text: 'x' }], top_n: 0 },
      },
    ],
  ])('rejects %s locally without network egress', async (_label, partial) => {
    const response = await connector.execute({ prompt: 'unused', ...partial });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.status).toBe('error');
    expect(response.error).toMatchObject({
      type: 'validation_error',
      retryable: false,
      recommendation: 'abort',
    });
  });

  it('rejects a missing API key locally without echoing credentials', async () => {
    delete process.env.PINECONE_API_KEY;
    const response = await connector.execute({
      prompt: 'unused',
      model: 'm',
      extra: { operation: 'embed', inputs: [{ text: 'x' }] },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response.error).toMatchObject({
      type: 'auth_error',
      retryable: false,
      recommendation: 'reauth',
    });
    expect(response.error?.message).toBe('Pinecone API key is not configured');
  });

  it.each([
    [400, 'validation_error', 'error'],
    [401, 'auth_error', 'error'],
    [403, 'auth_error', 'error'],
    [429, 'rate_limited', 'rate_limited'],
    [503, 'server_error', 'error'],
  ] as const)('reuses base HTTP classification for status %i', async (status, type, resultStatus) => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { message: 'synthetic failure' } }, status));
    const response = await connector.execute({
      prompt: 'unused',
      model: 'm',
      extra: { operation: 'embed', inputs: [{ text: 'x' }] },
    });

    expect(response.status).toBe(resultStatus);
    expect(response.error?.type).toBe(type);
  });

  it('redacts the configured API key if a provider error body echoes it', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'invalid key synthetic-test-key' } }, 401),
    );
    const response = await connector.execute({
      prompt: 'unused',
      model: 'm',
      extra: { operation: 'embed', inputs: [{ text: 'x' }] },
    });

    expect(response.error?.message).not.toContain('synthetic-test-key');
    expect(response.error?.message).toContain('[REDACTED]');
  });

  it('returns a parse error for a malformed provider response without forwarding data', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ model: 'm', data: [] }));
    const response = await connector.execute({
      prompt: 'unused',
      model: 'm',
      extra: { operation: 'embed', inputs: [{ text: 'x' }] },
    });

    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('api_error');
    expect(response.error?.message).toBe('Malformed Pinecone embed response');
  });
});

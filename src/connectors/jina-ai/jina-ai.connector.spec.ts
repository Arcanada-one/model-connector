import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JinaAiConnector } from './jina-ai.connector';

type EmbeddingsFixture = {
  _fixture: { provenance: string; captured: boolean; description: string };
  object: string;
  data: unknown[];
  model: string;
  usage: { total_tokens: number };
};

type RerankFixture = {
  _fixture: { provenance: string; captured: boolean; description: string };
  object: string;
  results: unknown[];
  model: string;
  usage: { total_tokens: number };
};

const embeddingsFixture = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/embeddings-response.synthetic.json'), 'utf8'),
) as EmbeddingsFixture;
const rerankFixture = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/rerank-response.synthetic.json'), 'utf8'),
) as RerankFixture;

const SYNTHETIC_API_KEY = 'jina_synthetic_test_key_not_a_secret';

describe('JinaAiConnector (AU-024)', () => {
  let connector: JinaAiConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.JINA_API_KEY = SYNTHETIC_API_KEY;
    connector = new JinaAiConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.JINA_API_KEY;
  });

  function mockOk(body: unknown): void {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  }

  function mockError(status: number, body: string): void {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status,
      text: () => Promise.resolve(body),
    });
  }

  describe('synthetic fixture provenance', () => {
    it.each([embeddingsFixture, rerankFixture])(
      'labels every schema-derived fixture synthetic and uncaptured',
      (fixture) => {
        expect(fixture._fixture.provenance).toBe('synthetic');
        expect(fixture._fixture.captured).toBe(false);
        expect(fixture._fixture.description).toContain('never returned by a provider call');
      },
    );
  });

  describe('authentication and endpoint selection', () => {
    it('posts embeddings to the public Jina v1 endpoint by default', async () => {
      mockOk(embeddingsFixture);

      await connector.execute({ prompt: 'synthetic query' });

      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.jina.ai/v1/embeddings');
      expect(fetchSpy.mock.calls[0][1].method).toBe('POST');
    });

    it('posts rerank to the public Jina v1 endpoint', async () => {
      mockOk(rerankFixture);

      await connector.execute({
        prompt: 'synthetic query',
        extra: { operation: 'rerank', documents: ['first', 'second'] },
      });

      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.jina.ai/v1/rerank');
    });

    it('sends the API key only as a bearer authorization header', async () => {
      mockOk(embeddingsFixture);

      await connector.execute({ prompt: 'synthetic input' });

      const options = fetchSpy.mock.calls[0][1];
      expect(options.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SYNTHETIC_API_KEY}`,
      });
      expect(options.body).not.toContain(SYNTHETIC_API_KEY);
    });
  });

  describe('embeddings request and response', () => {
    it('maps every admitted v3 option to provider snake_case', async () => {
      mockOk({ ...embeddingsFixture, model: 'jina-embeddings-v3' });

      await connector.execute({
        prompt: 'ignored when inputs are present',
        model: 'jina-embeddings-v3',
        extra: {
          inputs: ['synthetic query', 'synthetic passage'],
          embeddingType: 'base64',
          normalized: false,
          truncate: true,
          task: 'retrieval.passage',
          lateChunking: true,
          dimensions: 512,
        },
      });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
        input: ['synthetic query', 'synthetic passage'],
        model: 'jina-embeddings-v3',
        embedding_type: 'base64',
        normalized: false,
        truncate: true,
        task: 'retrieval.passage',
        late_chunking: true,
        dimensions: 512,
      });
    });

    it('maps documented v4 multimodal input and multivector options', async () => {
      mockOk(embeddingsFixture);

      await connector.execute({
        prompt: 'ignored when inputs are present',
        extra: {
          inputs: [
            { text: 'synthetic text' },
            { image: 'https://example.invalid/synthetic.png' },
          ],
          task: 'retrieval.passage',
          returnMultivector: true,
          returnTokenizedInput: true,
        },
      });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
        input: [
          { text: 'synthetic text' },
          { image: 'https://example.invalid/synthetic.png' },
        ],
        model: 'jina-embeddings-v4',
        task: 'retrieval.passage',
        return_multivector: true,
        return_tokenized_input: true,
      });
    });

    it('maps a documented single PDF input without fetching it locally', async () => {
      mockOk(embeddingsFixture);

      await connector.execute({
        prompt: 'ignored when inputs are present',
        extra: { inputs: { pdf: 'https://example.invalid/synthetic.pdf' }, dimensions: 256 },
      });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body).input).toEqual({
        pdf: 'https://example.invalid/synthetic.pdf',
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('uses the frozen default model and preserves data indexes and token usage', async () => {
      mockOk(embeddingsFixture);

      const response = await connector.execute({
        prompt: 'synthetic input',
        extra: { inputs: ['one', 'two'] },
      });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body).model).toBe('jina-embeddings-v4');
      expect(response.status).toBe('success');
      expect(response.structured).toEqual(embeddingsFixture.data);
      expect((response.structured as Array<{ index: number }>).map((entry) => entry.index)).toEqual([
        0, 1,
      ]);
      expect(response.usage).toEqual({
        inputTokens: 8,
        outputTokens: 0,
        totalTokens: 8,
        costUsd: 0,
      });
    });
  });

  describe('rerank request and response', () => {
    it('maps the common rerank fields and v3-only options', async () => {
      mockOk(rerankFixture);

      await connector.execute({
        prompt: 'Which synthetic document is relevant?',
        extra: {
          operation: 'rerank',
          documents: ['first', { text: 'second' }],
          topN: 1,
          returnDocuments: true,
          truncation: false,
          maxDocLength: 4096,
          returnEmbeddings: true,
        },
      });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
        query: 'Which synthetic document is relevant?',
        documents: ['first', { text: 'second' }],
        model: 'jina-reranker-v3',
        top_n: 1,
        return_documents: true,
        truncation: false,
        max_doc_length: 4096,
        return_embeddings: true,
      });
    });

    it('maps m0 image query and image documents only for the multimodal reranker', async () => {
      mockOk({ ...rerankFixture, model: 'jina-reranker-m0' });

      await connector.execute({
        prompt: 'fallback text query',
        model: 'jina-reranker-m0',
        extra: {
          operation: 'rerank',
          query: { image: 'https://example.invalid/query.png' },
          documents: [{ image: 'https://example.invalid/document.png' }, 'text document'],
        },
      });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body).query).toEqual({
        image: 'https://example.invalid/query.png',
      });
    });

    it('preserves provider relevance order, original indexes, documents, and usage', async () => {
      mockOk(rerankFixture);

      const response = await connector.execute({
        prompt: 'synthetic query',
        extra: { operation: 'rerank', documents: ['first', 'second'] },
      });

      expect(response.status).toBe('success');
      expect(response.structured).toEqual(rerankFixture.results);
      expect(response.result).toBe(JSON.stringify(rerankFixture.results));
      expect(
        (response.structured as Array<{ index: number; relevance_score: number }>).map((entry) => [
          entry.index,
          entry.relevance_score,
        ]),
      ).toEqual([
        [1, 0.9375],
        [0, 0.125],
      ]);
      expect(response.usage.totalTokens).toBe(23);
    });
  });

  describe('local validation before egress', () => {
    it.each([
      [{ prompt: 'x', extra: { operation: 'unknown' } }, 'operation'],
      [{ prompt: '', model: 'jina-embeddings-v4' }, 'input'],
      [{ prompt: 'x', model: 'jina-reranker-v3' }, 'operation'],
      [{ prompt: 'x', extra: { inputs: [] } }, 'inputs'],
      [{ prompt: 'x', extra: { inputs: [{ audio: 'unsupported' }] } }, 'inputs'],
      [
        { prompt: 'x', extra: { inputs: [{ pdf: 'one' }, { pdf: 'two' }] } },
        'PDF',
      ],
      [{ prompt: 'x', extra: { embeddingType: 'hex' } }, 'embeddingType'],
      [{ prompt: 'x', extra: { truncate: 'yes' } }, 'truncate'],
      [{ prompt: 'x', model: 'jina-embeddings-v3', extra: { dimensions: 1025 } }, 'dimensions'],
      [{ prompt: 'x', model: 'jina-embeddings-v4', extra: { dimensions: 2049 } }, 'dimensions'],
      [
        {
          prompt: 'x',
          extra: { dimensions: 512, returnMultivector: true },
        },
        'mutually exclusive',
      ],
      [{ prompt: 'x', extra: { returnTokenizedInput: true } }, 'requires returnMultivector'],
      [
        {
          prompt: 'x',
          extra: {
            inputs: [{ image: 'https://example.invalid/image.png' }],
            lateChunking: true,
          },
        },
        'text-only',
      ],
      [{ prompt: 'x', extra: { operation: 'rerank' } }, 'documents'],
      [
        {
          prompt: 'x',
          extra: { operation: 'rerank', documents: [{ image: 'unsupported' }] },
        },
        'documents',
      ],
      [
        {
          prompt: 'x',
          model: 'jina-reranker-m0',
          extra: { operation: 'rerank', query: { image: '' }, documents: ['one'] },
        },
        'query',
      ],
      [
        { prompt: 'x', extra: { operation: 'rerank', documents: ['one'], topN: 2 } },
        'topN',
      ],
      [
        {
          prompt: 'x',
          model: 'jina-reranker-v2-base-multilingual',
          extra: { operation: 'rerank', documents: ['one'], maxDocLength: 1024 },
        },
        'v3-only',
      ],
    ])('returns validation_error without fetch for %#', async (request, message) => {
      const response = await connector.execute(request as never);

      expect(response.status).toBe('error');
      expect(response.error).toMatchObject({
        type: 'validation_error',
        retryable: false,
        recommendation: 'abort',
      });
      expect(response.error?.message).toContain(message);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('provider response, errors, and auth redaction', () => {
    it.each([
      [400, 'validation_error', 'error'],
      [401, 'auth_error', 'error'],
      [403, 'auth_error', 'error'],
      [422, 'validation_error', 'error'],
      [429, 'rate_limited', 'rate_limited'],
      [503, 'server_error', 'error'],
    ])('maps HTTP %i to %s', async (status, type, responseStatus) => {
      mockError(status, JSON.stringify({ detail: `synthetic HTTP ${status}` }));

      const response = await connector.execute({ prompt: 'synthetic input' });

      expect(response.status).toBe(responseStatus);
      expect(response.error?.type).toBe(type);
    });

    it('rejects malformed provider results as api_error', async () => {
      mockOk({ model: 'jina-embeddings-v4', usage: { total_tokens: -1 }, data: {} });

      const response = await connector.execute({ prompt: 'synthetic input' });

      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('api_error');
    });

    it('redacts the active bearer value if a provider error echoes it', async () => {
      mockError(401, JSON.stringify({ detail: `invalid key ${SYNTHETIC_API_KEY}` }));

      const response = await connector.execute({ prompt: 'synthetic input' });

      expect(response.error?.message).toContain('[REDACTED]');
      expect(JSON.stringify(response)).not.toContain(SYNTHETIC_API_KEY);
    });
  });

  describe('capability boundary', () => {
    it('advertises one provider identity and only the frozen embeddings/rerank floor', () => {
      const capabilities = connector.getCapabilities();

      expect(capabilities).toMatchObject({
        name: 'jina-ai',
        type: 'api',
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
      });
      expect(capabilities.models).toEqual([
        'jina-embeddings-v3',
        'jina-embeddings-v4',
        'jina-reranker-v2-base-multilingual',
        'jina-reranker-m0',
        'jina-reranker-v3',
      ]);
      expect(capabilities.modelMeta?.filter((model) => model.modality === 'embedding')).toHaveLength(
        2,
      );
      expect(capabilities.modelMeta?.filter((model) => model.modality === 'rerank')).toHaveLength(3);
    });

    it('does not advertise excluded operations, dynamic registration, regions, or Pinecone', () => {
      expect(JSON.stringify(connector.getCapabilities())).not.toMatch(
        /reader|search|segment|classif|batch|chat|models_url|region|pinecone/i,
      );
    });
  });
});

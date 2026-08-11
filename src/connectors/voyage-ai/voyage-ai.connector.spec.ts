import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoyageAiConnector } from './voyage-ai.connector';

type SyntheticFixture = {
  _fixture: { provenance: string; captured: boolean; description: string };
  object: string;
  data: unknown[];
  model: string;
  usage: { total_tokens: number };
};

const embeddingsFixture = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/embeddings-response.synthetic.json'), 'utf8'),
) as SyntheticFixture;
const rerankFixture = JSON.parse(
  readFileSync(resolve(__dirname, '__fixtures__/rerank-response.synthetic.json'), 'utf8'),
) as SyntheticFixture;

const SYNTHETIC_API_KEY = 'voyage_synthetic_test_key_not_a_secret';

describe('VoyageAiConnector (AU-023)', () => {
  let connector: VoyageAiConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.VOYAGE_API_KEY = SYNTHETIC_API_KEY;
    connector = new VoyageAiConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VOYAGE_API_KEY;
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
    it('posts embeddings to the public Voyage v1 embeddings endpoint by default', async () => {
      mockOk(embeddingsFixture);

      await connector.execute({ prompt: 'synthetic query' });

      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.voyageai.com/v1/embeddings');
      expect(fetchSpy.mock.calls[0][1].method).toBe('POST');
    });

    it('posts rerank to the public Voyage v1 rerank endpoint', async () => {
      mockOk(rerankFixture);

      await connector.execute({
        prompt: 'synthetic query',
        extra: { operation: 'rerank', documents: ['first', 'second'] },
      });

      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.voyageai.com/v1/rerank');
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
    it('maps batch inputs and every admitted embeddings option to provider snake_case', async () => {
      mockOk(embeddingsFixture);

      await connector.execute({
        prompt: 'ignored when inputs are present',
        model: 'voyage-4-large',
        extra: {
          inputs: ['synthetic query', 'synthetic document'],
          inputType: 'document',
          truncation: false,
          outputDimension: 512,
          outputDtype: 'int8',
          encodingFormat: 'base64',
        },
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).toEqual({
        input: ['synthetic query', 'synthetic document'],
        model: 'voyage-4-large',
        input_type: 'document',
        truncation: false,
        output_dimension: 512,
        output_dtype: 'int8',
        encoding_format: 'base64',
      });
    });

    it('uses the documented current default embedding model and omits absent options', async () => {
      mockOk(embeddingsFixture);

      await connector.execute({ prompt: 'synthetic input' });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
        input: 'synthetic input',
        model: 'voyage-4-large',
      });
    });

    it('preserves embedding indexes and maps total token usage', async () => {
      mockOk(embeddingsFixture);

      const response = await connector.execute({
        prompt: 'synthetic input',
        extra: { inputs: ['one', 'two'] },
      });

      expect(response.status).toBe('success');
      expect(response.model).toBe('voyage-4-large');
      expect(response.structured).toEqual(embeddingsFixture.data);
      expect(response.result).toBe(JSON.stringify(embeddingsFixture.data));
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
    it('maps query, documents, top_k, return_documents, and explicit false truncation', async () => {
      mockOk(rerankFixture);

      await connector.execute({
        prompt: 'Which synthetic document is relevant?',
        model: 'rerank-2.5-lite',
        extra: {
          operation: 'rerank',
          documents: ['first', 'second'],
          topK: 1,
          returnDocuments: true,
          truncation: false,
        },
      });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
        query: 'Which synthetic document is relevant?',
        documents: ['first', 'second'],
        model: 'rerank-2.5-lite',
        top_k: 1,
        return_documents: true,
        truncation: false,
      });
    });

    it('uses the documented current default rerank model', async () => {
      mockOk(rerankFixture);

      await connector.execute({
        prompt: 'synthetic query',
        extra: { operation: 'rerank', documents: ['first'] },
      });

      expect(JSON.parse(fetchSpy.mock.calls[0][1].body).model).toBe('rerank-2.5');
    });

    it('preserves provider relevance order, original indexes, optional documents, and usage', async () => {
      mockOk(rerankFixture);

      const response = await connector.execute({
        prompt: 'synthetic query',
        extra: { operation: 'rerank', documents: ['first', 'second'] },
      });

      expect(response.status).toBe('success');
      expect(response.structured).toEqual(rerankFixture.data);
      expect(response.result).toBe(JSON.stringify(rerankFixture.data));
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
      expect(response.usage.outputTokens).toBe(0);
    });
  });

  describe('local validation before egress', () => {
    it.each([
      [{ prompt: 'x', extra: { operation: 'unknown' } }, 'operation'],
      [{ prompt: '' }, 'input'],
      [{ prompt: 'x', extra: { inputs: [] } }, 'inputs'],
      [{ prompt: 'x', extra: { inputs: Array.from({ length: 1001 }, () => 'x') } }, '1,000'],
      [{ prompt: 'x', extra: { inputType: 'search' } }, 'inputType'],
      [{ prompt: 'x', extra: { outputDimension: 384 } }, 'outputDimension'],
      [
        { prompt: 'x', model: 'voyage-finance-2', extra: { outputDimension: 512 } },
        'flexible dimensions',
      ],
      [{ prompt: 'x', extra: { outputDtype: 'float16' } }, 'outputDtype'],
      [{ prompt: 'x', extra: { encodingFormat: 'hex' } }, 'encodingFormat'],
      [{ prompt: 'x', extra: { operation: 'rerank' } }, 'documents'],
      [
        {
          prompt: 'x',
          extra: { operation: 'rerank', documents: Array.from({ length: 1001 }, () => 'x') },
        },
        '1,000',
      ],
      [
        { prompt: 'x', extra: { operation: 'rerank', documents: ['one'], topK: 2 } },
        'topK',
      ],
      [
        {
          prompt: 'x',
          extra: { operation: 'rerank', documents: ['one'], returnDocuments: 'yes' },
        },
        'returnDocuments',
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

  describe('provider errors and auth redaction', () => {
    it.each([
      [400, 'validation_error', 'error'],
      [401, 'auth_error', 'error'],
      [403, 'http_error', 'error'],
      [429, 'rate_limited', 'rate_limited'],
      [503, 'server_error', 'error'],
    ])('maps HTTP %i to %s', async (status, type, responseStatus) => {
      mockError(status, JSON.stringify({ detail: `synthetic HTTP ${status}` }));

      const response = await connector.execute({ prompt: 'synthetic input' });

      expect(response.status).toBe(responseStatus);
      expect(response.error?.type).toBe(type);
    });

    it('redacts the active bearer value if a provider error echoes it', async () => {
      mockError(401, JSON.stringify({ detail: `invalid key ${SYNTHETIC_API_KEY}` }));

      const response = await connector.execute({ prompt: 'synthetic input' });

      expect(response.error?.message).toContain('[REDACTED]');
      expect(response.error?.message).not.toContain(SYNTHETIC_API_KEY);
      expect(JSON.stringify(response)).not.toContain(SYNTHETIC_API_KEY);
    });
  });

  describe('capability boundary', () => {
    it('advertises only the frozen current embeddings and rerank model floor', () => {
      const capabilities = connector.getCapabilities();

      expect(capabilities).toMatchObject({
        name: 'voyage-ai',
        type: 'api',
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
      });
      expect(capabilities.models).toEqual([
        'voyage-4-large',
        'voyage-4',
        'voyage-4-lite',
        'voyage-code-3',
        'voyage-finance-2',
        'voyage-law-2',
        'rerank-2.5',
        'rerank-2.5-lite',
      ]);
      expect(capabilities.modelMeta?.filter((model) => model.modality === 'embedding')).toHaveLength(
        6,
      );
      expect(capabilities.modelMeta?.filter((model) => model.modality === 'rerank')).toHaveLength(2);
    });

    it('does not expose dynamic discovery, multimodal, contextualized, batch, or Jina claims', () => {
      const serialized = JSON.stringify(connector.getCapabilities());

      expect(serialized).not.toMatch(
        /jina|multimodalembeddings|contextualizedembeddings|batch|files|models_url/i,
      );
    });
  });
});

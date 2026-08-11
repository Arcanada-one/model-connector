import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chatSuccess from './__fixtures__/chat-success.synthetic.json';
import embedSuccess from './__fixtures__/embed-success.synthetic.json';
import modelsPage1 from './__fixtures__/models-page-1.synthetic.json';
import modelsPage2 from './__fixtures__/models-page-2.synthetic.json';
import rerankSuccess from './__fixtures__/rerank-success.synthetic.json';
import { CohereConnector } from './cohere.connector';

const SYNTHETIC_KEY = 'cohere_synthetic_secret_0286';
const IMAGE_DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';

describe('CohereConnector', () => {
  let connector: CohereConnector;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.COHERE_API_KEY = SYNTHETIC_KEY;
    connector = new CohereConnector();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COHERE_API_KEY;
    delete process.env.COHERE_BASE_URL;
    delete process.env.COHERE_TIMEOUT_MS;
  });

  describe('immutable Chat behavior', () => {
    it('preserves provider identity, native v2 Chat body, and Bearer authentication', async () => {
      fetchMock.mockResolvedValueOnce(ok(chatSuccess));

      const response = await connector.execute({
        prompt: 'Hello',
        systemPrompt: 'Be concise',
        extra: { max_tokens: 64, temperature: 0.2, p: 0.9, k: 20, stop_sequences: ['END'] },
      });

      expect(connector.name).toBe('cohere');
      expect(response.result).toBe('Synthetic Cohere chat');
      expect(response.usage).toEqual({
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        costUsd: 0,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.cohere.com/v2/chat');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${SYNTHETIC_KEY}`);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        model: 'command-a-03-2025',
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'Hello' },
        ],
        max_tokens: 64,
        temperature: 0.2,
        p: 0.9,
        k: 20,
        stop_sequences: ['END'],
      });
    });

    it('keeps an unknown operation on the Chat path without forwarding the discriminator', async () => {
      fetchMock.mockResolvedValueOnce(ok(chatSuccess));

      await connector.execute({ prompt: 'Hello', extra: { operation: 'unsupported-operation' } });

      expect(fetchMock.mock.calls[0][0]).toBe('https://api.cohere.com/v2/chat');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        model: 'command-a-03-2025',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    it('preserves paginated active Chat discovery and capability metadata', async () => {
      fetchMock.mockResolvedValueOnce(ok(modelsPage1)).mockResolvedValueOnce(ok(modelsPage2));

      await connector.refreshModels();

      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        'https://api.cohere.com/v1/models?page_size=1000',
        'https://api.cohere.com/v1/models?page_size=1000&page_token=synthetic-page-2',
      ]);
      expect(connector.getCapabilities()).toEqual({
        name: 'cohere',
        type: 'api',
        models: ['synthetic-chat-current', 'synthetic-shared-current'],
        modelMeta: [
          { id: 'synthetic-chat-current', contextWindow: 12000 },
          { id: 'synthetic-shared-current', contextWindow: 16000 },
        ],
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
        maxTimeout: 300000,
      });
    });

    it.each([
      [401, 'auth_error'],
      [403, 'auth_error'],
      [498, 'auth_error'],
      [404, 'model_not_found'],
      [422, 'validation_error'],
      [429, 'rate_limited'],
      [499, 'timeout'],
      [503, 'server_error'],
      [504, 'timeout'],
    ])('preserves HTTP %i classification as %s', async (status, type) => {
      fetchMock.mockResolvedValueOnce(providerError(status, 'synthetic provider error'));
      const response = await connector.execute({ prompt: 'Hello', model: 'synthetic-chat' });
      expect(response.error?.type).toBe(type);
    });
  });

  describe('Embed v2 operation', () => {
    it('sends a strict allowlisted text request and normalizes typed embeddings', async () => {
      fetchMock.mockResolvedValueOnce(ok(embedSuccess));

      const response = await connector.execute({
        prompt: 'unused compatibility prompt',
        model: 'embed-v4.0',
        extra: {
          operation: 'embed',
          texts: ['synthetic document'],
          input_type: 'search_document',
          embedding_types: ['float', 'int8', 'base64'],
          output_dimension: 1024,
          truncate: 'END',
          max_tokens: 128,
          priority: 4,
          undocumented: 'must-not-pass',
        },
      });

      expect(fetchMock.mock.calls[0][0]).toBe('https://api.cohere.com/v2/embed');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${SYNTHETIC_KEY}`);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        model: 'embed-v4.0',
        texts: ['synthetic document'],
        input_type: 'search_document',
        embedding_types: ['float', 'int8', 'base64'],
        output_dimension: 1024,
        truncate: 'END',
        max_tokens: 128,
        priority: 4,
      });
      expect(response.status).toBe('success');
      expect(response.model).toBe('embed-v4.0');
      expect(response.structured).toEqual(embedSuccess);
      expect(JSON.parse(response.result)).toEqual(embedSuccess.embeddings);
      expect(response.usage).toEqual({
        inputTokens: 4,
        outputTokens: 0,
        totalTokens: 4,
        costUsd: 0,
      });
    });

    it('accepts one documented image data URI', async () => {
      fetchMock.mockResolvedValueOnce(ok(embedSuccess));

      await connector.execute({
        prompt: '',
        model: 'embed-v4.0',
        extra: {
          operation: 'embed',
          images: [IMAGE_DATA_URI],
          input_type: 'image',
          embedding_types: ['float'],
        },
      });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        model: 'embed-v4.0',
        images: [IMAGE_DATA_URI],
        input_type: 'image',
        embedding_types: ['float'],
      });
    });

    it('accepts documented structured mixed text/image content', async () => {
      fetchMock.mockResolvedValueOnce(ok(embedSuccess));
      const inputs = [
        {
          content: [
            { type: 'text', text: 'synthetic document' },
            { type: 'image_url', image_url: { url: IMAGE_DATA_URI } },
          ],
        },
      ];

      await connector.execute({
        prompt: '',
        model: 'embed-v4.0',
        extra: { operation: 'embed', inputs, input_type: 'classification' },
      });

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        model: 'embed-v4.0',
        inputs,
        input_type: 'classification',
      });
    });

    it.each([
      [
        'missing model',
        { prompt: '', extra: { operation: 'embed', texts: ['x'], input_type: 'classification' } },
      ],
      [
        'missing source',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: { operation: 'embed', input_type: 'classification' },
        },
      ],
      [
        'multiple sources',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: {
            operation: 'embed',
            texts: ['x'],
            images: [IMAGE_DATA_URI],
            input_type: 'classification',
          },
        },
      ],
      [
        'empty texts',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: { operation: 'embed', texts: [], input_type: 'classification' },
        },
      ],
      [
        'invalid input type',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: { operation: 'embed', texts: ['x'], input_type: 'semantic' },
        },
      ],
      [
        'invalid image MIME',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: {
            operation: 'embed',
            images: ['data:image/svg+xml;base64,PHN2Zz4='],
            input_type: 'image',
          },
        },
      ],
      [
        'too many images',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: {
            operation: 'embed',
            images: [IMAGE_DATA_URI, IMAGE_DATA_URI],
            input_type: 'image',
          },
        },
      ],
      [
        'invalid structured input',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: {
            operation: 'embed',
            inputs: [{ content: [{ type: 'audio', audio: 'x' }] }],
            input_type: 'classification',
          },
        },
      ],
      [
        'invalid embedding type',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: {
            operation: 'embed',
            texts: ['x'],
            input_type: 'classification',
            embedding_types: ['decimal'],
          },
        },
      ],
      [
        'invalid dimension',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: {
            operation: 'embed',
            texts: ['x'],
            input_type: 'classification',
            output_dimension: 768,
          },
        },
      ],
      [
        'dimension on pre-v4 model',
        {
          prompt: '',
          model: 'embed-english-v3.0',
          extra: {
            operation: 'embed',
            texts: ['x'],
            input_type: 'classification',
            output_dimension: 1024,
          },
        },
      ],
      [
        'invalid truncate',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: {
            operation: 'embed',
            texts: ['x'],
            input_type: 'classification',
            truncate: 'MIDDLE',
          },
        },
      ],
      [
        'invalid max tokens',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: { operation: 'embed', texts: ['x'], input_type: 'classification', max_tokens: 0 },
        },
      ],
      [
        'invalid priority',
        {
          prompt: '',
          model: 'embed-v4.0',
          extra: { operation: 'embed', texts: ['x'], input_type: 'classification', priority: 1000 },
        },
      ],
    ])('rejects %s before fetch', async (_label, request) => {
      const response = await connector.execute(request);
      expect(response.status).toBe('error');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a text batch above the documented 96-entry bound before fetch', async () => {
      const response = await connector.execute({
        prompt: '',
        model: 'embed-v4.0',
        extra: {
          operation: 'embed',
          texts: Array.from({ length: 97 }, (_, index) => `synthetic-${index}`),
          input_type: 'classification',
        },
      });
      expect(response.status).toBe('error');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an image over the documented 5 MB decoded limit before fetch', async () => {
      const oversized = `data:image/png;base64,${'A'.repeat(6_990_512)}`;
      const response = await connector.execute({
        prompt: '',
        model: 'embed-v4.0',
        extra: { operation: 'embed', images: [oversized], input_type: 'image' },
      });
      expect(response.status).toBe('error');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Rerank v2 operation', () => {
    it('sends an allowlisted string-document request and preserves ordered results', async () => {
      fetchMock.mockResolvedValueOnce(ok(rerankSuccess));
      const documents = ['synthetic zero', 'synthetic one', 'synthetic two'];

      const response = await connector.execute({
        prompt: '',
        model: 'rerank-v4.0-pro',
        extra: {
          operation: 'rerank',
          query: 'synthetic query',
          documents,
          top_n: 3,
          max_tokens_per_doc: 4096,
          priority: 8,
          return_documents: true,
        },
      });

      expect(fetchMock.mock.calls[0][0]).toBe('https://api.cohere.com/v2/rerank');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        model: 'rerank-v4.0-pro',
        query: 'synthetic query',
        documents,
        top_n: 3,
        max_tokens_per_doc: 4096,
        priority: 8,
      });
      expect(response.status).toBe('success');
      expect(response.model).toBe('rerank-v4.0-pro');
      expect(response.structured).toEqual(rerankSuccess);
      expect(JSON.parse(response.result)).toEqual(rerankSuccess.results);
      expect(response.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      });
      expect((response.structured as typeof rerankSuccess).meta.billed_units.search_units).toBe(1);
    });

    it.each([
      [
        'missing model',
        { prompt: '', extra: { operation: 'rerank', query: 'q', documents: ['d'] } },
      ],
      [
        'empty query',
        {
          prompt: '',
          model: 'rerank-v4.0-pro',
          extra: { operation: 'rerank', query: '', documents: ['d'] },
        },
      ],
      [
        'empty documents',
        {
          prompt: '',
          model: 'rerank-v4.0-pro',
          extra: { operation: 'rerank', query: 'q', documents: [] },
        },
      ],
      [
        'object document',
        {
          prompt: '',
          model: 'rerank-v4.0-pro',
          extra: { operation: 'rerank', query: 'q', documents: [{ text: 'd' }] },
        },
      ],
      [
        'invalid top n',
        {
          prompt: '',
          model: 'rerank-v4.0-pro',
          extra: { operation: 'rerank', query: 'q', documents: ['d'], top_n: 0 },
        },
      ],
      [
        'invalid max tokens',
        {
          prompt: '',
          model: 'rerank-v4.0-pro',
          extra: { operation: 'rerank', query: 'q', documents: ['d'], max_tokens_per_doc: 0 },
        },
      ],
      [
        'invalid priority',
        {
          prompt: '',
          model: 'rerank-v4.0-pro',
          extra: { operation: 'rerank', query: 'q', documents: ['d'], priority: -1 },
        },
      ],
    ])('rejects %s before fetch', async (_label, request) => {
      const response = await connector.execute(request);
      expect(response.status).toBe('error');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('operation catalogue', () => {
    it('paginates once and separates active Embed and Rerank models without changing Chat', async () => {
      fetchMock.mockResolvedValueOnce(ok(modelsPage1)).mockResolvedValueOnce(ok(modelsPage2));

      await connector.refreshOperationModels();

      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        'https://api.cohere.com/v1/models?page_size=1000',
        'https://api.cohere.com/v1/models?page_size=1000&page_token=synthetic-page-2',
      ]);
      expect(connector.getOperationModels('embed')).toEqual([
        { id: 'synthetic-embed-current', contextWindow: 8000 },
        { id: 'synthetic-shared-current', contextWindow: 16000 },
      ]);
      expect(connector.getOperationModels('rerank')).toEqual([
        { id: 'synthetic-shared-current', contextWindow: 16000 },
        { id: 'synthetic-rerank-current', contextWindow: 6000 },
      ]);
      expect(connector.getCapabilities().models).toEqual(['command-a-03-2025']);
    });
  });

  describe('Bearer redaction', () => {
    it('redacts the request credential from a provider-error body', async () => {
      fetchMock.mockResolvedValueOnce(
        providerError(401, `provider echoed ${SYNTHETIC_KEY} and Bearer ${SYNTHETIC_KEY}`),
      );

      const response = await connector.execute({
        prompt: '',
        model: 'rerank-v4.0-pro',
        extra: { operation: 'rerank', query: 'q', documents: ['d'] },
      });

      expect(JSON.stringify(response)).not.toContain(SYNTHETIC_KEY);
      expect(response.error?.message).toContain('[REDACTED]');
    });

    it('redacts the request credential from a malformed-success path', async () => {
      fetchMock.mockResolvedValueOnce(ok({ id: SYNTHETIC_KEY, embeddings: null }));

      const response = await connector.execute({
        prompt: '',
        model: 'embed-v4.0',
        extra: { operation: 'embed', texts: ['d'], input_type: 'classification' },
      });

      expect(response.status).toBe('error');
      expect(JSON.stringify(response)).not.toContain(SYNTHETIC_KEY);
    });

    it('redacts the credential captured at request start even if the environment changes', async () => {
      let resolveFetch!: (value: ReturnType<typeof providerError>) => void;
      fetchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const pending = connector.execute({
        prompt: '',
        model: 'rerank-v4.0-pro',
        extra: { operation: 'rerank', query: 'q', documents: ['d'] },
      });
      process.env.COHERE_API_KEY = 'changed_after_request_start';
      resolveFetch(providerError(401, `echo ${SYNTHETIC_KEY}`));
      const response = await pending;

      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${SYNTHETIC_KEY}`);
      expect(JSON.stringify(response)).not.toContain(SYNTHETIC_KEY);
    });
  });
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function providerError(status: number, message: string) {
  return { ok: false, status, text: async () => JSON.stringify({ message }) };
}

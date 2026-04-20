import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingConnector } from './embedding.connector';

describe('EmbeddingConnector', () => {
  let connector: EmbeddingConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new EmbeddingConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    delete process.env.EMBEDDING_API_URL;
    delete process.env.EMBEDDING_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Fixtures from CONN-0006-fixtures.md ---

  const denseResponse = {
    object: 'list',
    data: [
      {
        object: 'embedding',
        embedding: Array.from({ length: 1024 }, (_, i) => i * 0.001),
        index: 0,
      },
    ],
    model: 'BAAI/bge-m3',
    usage: { prompt_tokens: 2, total_tokens: 2 },
  };

  const sparseResponse = {
    object: 'list',
    data: [
      {
        sparse_weights: { '6843': 0.217, '8999': 0.153, '2088': 0.042 },
        index: 0,
      },
    ],
    model: 'BAAI/bge-m3',
    usage: { prompt_tokens: 2, total_tokens: 2 },
  };

  const hybridResponse = {
    object: 'list',
    data: [
      {
        dense: Array.from({ length: 1024 }, (_, i) => i * 0.001),
        sparse_weights: { '6843': 0.217 },
        colbert: [Array.from({ length: 1024 }, (_, i) => i * 0.0001)],
        index: 0,
      },
    ],
    model: 'BAAI/bge-m3',
    usage: { prompt_tokens: 2, total_tokens: 2 },
  };

  const batchDenseResponse = {
    object: 'list',
    data: [
      { object: 'embedding', embedding: [0.1, 0.2], index: 0 },
      { object: 'embedding', embedding: [0.3, 0.4], index: 1 },
    ],
    model: 'BAAI/bge-m3',
    usage: { prompt_tokens: 4, total_tokens: 4 },
  };

  function mockOk(body: unknown) {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  }

  // --- URL building ---

  describe('buildRequestUrl', () => {
    it('should use /v1/embeddings for dense (default)', async () => {
      mockOk(denseResponse);
      await connector.execute({ prompt: 'test' });
      expect(fetchSpy.mock.calls[0][0]).toBe('http://100.70.137.104:8300/v1/embeddings');
    });

    it('should use /v1/embeddings/sparse for sparse', async () => {
      mockOk(sparseResponse);
      await connector.execute({ prompt: 'test', extra: { embeddingType: 'sparse' } });
      expect(fetchSpy.mock.calls[0][0]).toBe('http://100.70.137.104:8300/v1/embeddings/sparse');
    });

    it('should use /v1/embeddings/colbert for colbert', async () => {
      mockOk(denseResponse);
      await connector.execute({ prompt: 'test', extra: { embeddingType: 'colbert' } });
      expect(fetchSpy.mock.calls[0][0]).toBe('http://100.70.137.104:8300/v1/embeddings/colbert');
    });

    it('should use /v1/embeddings/hybrid for hybrid', async () => {
      mockOk(hybridResponse);
      await connector.execute({ prompt: 'test', extra: { embeddingType: 'hybrid' } });
      expect(fetchSpy.mock.calls[0][0]).toBe('http://100.70.137.104:8300/v1/embeddings/hybrid');
    });

    it('should fall back to dense for unknown type', async () => {
      mockOk(denseResponse);
      await connector.execute({ prompt: 'test', extra: { embeddingType: 'invalid' } });
      expect(fetchSpy.mock.calls[0][0]).toBe('http://100.70.137.104:8300/v1/embeddings');
    });
  });

  // --- Request body ---

  describe('buildRequestBody', () => {
    it('should use prompt as input for single text', async () => {
      mockOk(denseResponse);
      await connector.execute({ prompt: 'hello world' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).toEqual({ input: 'hello world', model: 'bge-m3' });
    });

    it('should use extra.texts for batch input', async () => {
      mockOk(batchDenseResponse);
      await connector.execute({ prompt: 'ignored', extra: { texts: ['a', 'b'] } });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).toEqual({ input: ['a', 'b'], model: 'bge-m3' });
    });

    it('should use request.model when provided', async () => {
      mockOk(denseResponse);
      await connector.execute({ prompt: 'test', model: 'custom-model' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('custom-model');
    });
  });

  // --- Response parsing ---

  describe('parseResponse (dense)', () => {
    it('should return embeddings in structured and usage in tokens', async () => {
      mockOk(denseResponse);
      const response = await connector.execute({ prompt: 'test' });

      expect(response.status).toBe('success');
      expect(response.model).toBe('BAAI/bge-m3');
      expect(response.usage.inputTokens).toBe(2);
      expect(response.usage.costUsd).toBe(0);
      expect(response.structured).toEqual(denseResponse.data);
      expect(response.result).toBe(JSON.stringify(denseResponse.data));
    });
  });

  describe('parseResponse (sparse)', () => {
    it('should return sparse weights in structured', async () => {
      mockOk(sparseResponse);
      const response = await connector.execute({
        prompt: 'test',
        extra: { embeddingType: 'sparse' },
      });

      expect(response.status).toBe('success');
      expect(response.structured).toEqual(sparseResponse.data);
    });
  });

  describe('parseResponse (hybrid)', () => {
    it('should return all three embedding types in structured', async () => {
      mockOk(hybridResponse);
      const response = await connector.execute({
        prompt: 'test',
        extra: { embeddingType: 'hybrid' },
      });

      expect(response.status).toBe('success');
      const data = response.structured as typeof hybridResponse.data;
      expect(data[0]).toHaveProperty('dense');
      expect(data[0]).toHaveProperty('sparse_weights');
      expect(data[0]).toHaveProperty('colbert');
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('should return error for empty input (HTTP 400)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"detail":"input[0] must not be empty"}'),
      });

      const response = await connector.execute({ prompt: '' });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('validation_error');
      expect(response.error?.message).toContain('must not be empty');
    });
  });

  // --- Config ---

  describe('configuration', () => {
    it('should use default base URL', async () => {
      mockOk(denseResponse);
      await connector.execute({ prompt: 'test' });
      expect(fetchSpy.mock.calls[0][0]).toContain('100.70.137.104:8300');
    });

    it('should use EMBEDDING_API_URL from env', async () => {
      process.env.EMBEDDING_API_URL = 'http://custom:9999';
      connector = new EmbeddingConnector();
      mockOk(denseResponse);
      await connector.execute({ prompt: 'test' });
      expect(fetchSpy.mock.calls[0][0]).toContain('custom:9999');
    });

    it('should use EMBEDDING_TIMEOUT_MS from env', async () => {
      process.env.EMBEDDING_TIMEOUT_MS = '5000';
      connector = new EmbeddingConnector();
      mockOk(denseResponse);
      await connector.execute({ prompt: 'test' });
      // Timeout is passed to AbortSignal — we can't directly assert it,
      // but we verify it doesn't throw
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });

  // --- Capabilities ---

  describe('getCapabilities', () => {
    it('should return correct capability schema', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('embedding');
      expect(caps.type).toBe('api');
      expect(caps.models).toContain('bge-m3');
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.supportsJsonSchema).toBe(false);
      expect(caps.supportsTools).toBe(false);
      expect(caps.maxTimeout).toBe(60_000);
    });
  });
});

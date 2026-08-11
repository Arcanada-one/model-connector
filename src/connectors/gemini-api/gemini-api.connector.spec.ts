import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiApiConnector } from './gemini-api.connector';

const SYNTHETIC_KEY = 'synthetic-gemini-key-CONN-0284';
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(resolve(__dirname, '../../..', `test/fixtures/connectors/${name}`), 'utf8'),
  );

describe('GeminiApiConnector', () => {
  let connector: GeminiApiConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = SYNTHETIC_KEY;
    delete process.env.GEMINI_API_BASE_URL;
    connector = new GeminiApiConnector();
    fetchSpy = vi.fn(() => Promise.reject(new Error('unexpected network egress')));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GEMINI_API_KEY;
  });

  function mockOk(body: unknown): void {
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  }

  describe('immutable generation and discovery behavior', () => {
    it('keeps the distinct native API identity and generation route', async () => {
      mockOk(fixture('gemini-api-generate-success.synthetic.json'));
      const response = await connector.execute({ prompt: 'answer', model: 'gemini-2.5-flash' });
      expect(connector.name).toBe('gemini-api');
      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      );
      expect(response.result).toBe('{"answer":42}');
    });

    it('keeps structured generation mapping unchanged', async () => {
      mockOk(fixture('gemini-api-generate-success.synthetic.json'));
      const response = await connector.execute({
        prompt: 'answer',
        responseFormat: { type: 'json_object' },
      });
      expect(response.structured).toEqual({ answer: 42 });
      expect(response.usage.inputTokens).toBe(12);
      expect(response.usage.outputTokens).toBe(5);
    });

    it('keeps prompt-blocking failure semantics unchanged', async () => {
      mockOk(fixture('gemini-api-prompt-blocked.synthetic.json'));
      const response = await connector.execute({ prompt: 'blocked' });
      expect(response.status).toBe('error');
      expect(response.error?.message).toContain('SAFETY');
    });

    it('retains only generateContent models in completed discovery', () => {
      expect(
        connector['extractModels'](fixture('gemini-api-models.synthetic.json') as never),
      ).toEqual([{ id: 'gemini-2.5-flash' }, { id: 'gemini-2.5-pro' }]);
    });

    it('does not reinterpret an unknown operation as embeddings', async () => {
      mockOk(fixture('gemini-api-generate-success.synthetic.json'));
      await connector.execute({
        prompt: 'answer',
        model: 'gemini-2.5-flash',
        extra: { operation: 'moderations' },
      });
      expect(fetchSpy.mock.calls[0][0]).toContain(':generateContent');
    });
  });

  describe('AU-027 embeddings request contract', () => {
    it('uses embedContent with header-only API-key auth and current config fields', async () => {
      mockOk(fixture('gemini-api-embed-success.synthetic.json'));
      await connector.execute({
        prompt: 'A document',
        model: 'gemini-embedding-001',
        extra: {
          operation: 'embeddings',
          taskType: 'RETRIEVAL_DOCUMENT',
          title: 'Synthetic title',
          outputDimensionality: 256,
          forbidden: 'drop-me',
        },
      });

      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
      );
      expect(fetchSpy.mock.calls[0][0]).not.toContain(SYNTHETIC_KEY);
      expect(fetchSpy.mock.calls[0][1].headers).toEqual({
        'Content-Type': 'application/json',
        'x-goog-api-key': SYNTHETIC_KEY,
      });
      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: 'A document' }] },
        embedContentConfig: {
          taskType: 'RETRIEVAL_DOCUMENT',
          title: 'Synthetic title',
          outputDimensionality: 256,
        },
      });
    });

    it('uses batchEmbedContents for separate text inputs and repeats the path model', async () => {
      mockOk(fixture('gemini-api-batch-embed-success.synthetic.json'));
      await connector.execute({
        prompt: 'fallback',
        model: 'models/gemini-embedding-2',
        extra: { operation: 'embeddings', input: ['alpha', 'beta'], outputDimensionality: 128 },
      });
      expect(fetchSpy.mock.calls[0][0]).toContain(
        '/models/gemini-embedding-2:batchEmbedContents',
      );
      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
        model: 'models/gemini-embedding-2',
        requests: ['alpha', 'beta'].map((text) => ({
          model: 'models/gemini-embedding-2',
          content: { parts: [{ text }] },
          embedContentConfig: { outputDimensionality: 128 },
        })),
      });
    });
  });

  describe('AU-027 local validation', () => {
    it.each([
      ['missing model', { prompt: 'x', extra: { operation: 'embeddings' } }],
      ['unsupported model', { prompt: 'x', model: 'gemini-2.5-flash', extra: { operation: 'embeddings' } }],
      ['empty input', { prompt: '', model: 'gemini-embedding-2', extra: { operation: 'embeddings' } }],
      ['empty batch', { prompt: 'x', model: 'gemini-embedding-2', extra: { operation: 'embeddings', input: [] } }],
      ['mixed batch', { prompt: 'x', model: 'gemini-embedding-2', extra: { operation: 'embeddings', input: ['x', 1] } }],
      ['empty batch member', { prompt: 'x', model: 'gemini-embedding-2', extra: { operation: 'embeddings', input: ['x', ''] } }],
      ['invalid dimension', { prompt: 'x', model: 'gemini-embedding-2', extra: { operation: 'embeddings', outputDimensionality: 0 } }],
      ['invalid task type', { prompt: 'x', model: 'gemini-embedding-001', extra: { operation: 'embeddings', taskType: 'CHAT' } }],
      ['task type on v2', { prompt: 'x', model: 'gemini-embedding-2', extra: { operation: 'embeddings', taskType: 'CLUSTERING' } }],
      ['title without retrieval document', { prompt: 'x', model: 'gemini-embedding-001', extra: { operation: 'embeddings', taskType: 'CLUSTERING', title: 'bad' } }],
      ['multimodal field', { prompt: 'x', model: 'gemini-embedding-2', extra: { operation: 'embeddings', fileData: { uri: 'synthetic' } } }],
      ['async batch field', { prompt: 'x', model: 'gemini-embedding-2', extra: { operation: 'embeddings', asyncBatch: true } }],
    ])('rejects %s before transport', async (_label, request) => {
      const response = await connector.execute(request as never);
      expect(response.status).toBe('error');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('AU-027 response, usage, and redaction', () => {
    it('normalizes a finite single vector and prompt-token usage', async () => {
      mockOk(fixture('gemini-api-embed-success.synthetic.json'));
      const response = await connector.execute({
        prompt: 'x', model: 'gemini-embedding-2', extra: { operation: 'embeddings' },
      });
      expect(response.status).toBe('success');
      expect(response.result).toBe('[[0.125,-0.25,0.5]]');
      expect(response.structured).toEqual({
        embeddings: [[0.125, -0.25, 0.5]],
        usageMetadata: { promptTokenCount: 7 },
      });
      expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 0, totalTokens: 7, costUsd: 0 });
    });

    it('preserves ordered batch vectors', async () => {
      mockOk(fixture('gemini-api-batch-embed-success.synthetic.json'));
      const response = await connector.execute({
        prompt: 'x', model: 'gemini-embedding-2', extra: { operation: 'embeddings', input: ['a', 'b'] },
      });
      expect(response.status).toBe('success');
      expect((response.structured as { embeddings: number[][] }).embeddings).toEqual([
        [0.1, 0.2], [-0.3, 0.4],
      ]);
    });

    it.each([
      fixture('gemini-api-embed-malformed.synthetic.json'),
      { embedding: { values: [0.1, 'bad'] } },
      { embedding: { values: [0.1, null] } },
      { embeddings: [{ values: [0.1] }] },
    ])('rejects malformed-success envelope %# as api_error', async (body) => {
      mockOk(body);
      const response = await connector.execute({
        prompt: 'x', model: 'gemini-embedding-2',
        extra: { operation: 'embeddings', input: 'embeddings' in (body as object) ? ['a', 'b'] : 'a' },
      });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('api_error');
      expect(JSON.stringify(response)).not.toContain(SYNTHETIC_KEY);
    });

    it('redacts a provider error body that echoes the API key', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: `invalid ${SYNTHETIC_KEY}` } }),
      });
      const response = await connector.execute({
        prompt: 'x', model: 'gemini-embedding-2', extra: { operation: 'embeddings' },
      });
      expect(response.error?.type).toBe('auth_error');
      expect(JSON.stringify(response)).not.toContain(SYNTHETIC_KEY);
      expect(response.error?.message).toContain('[REDACTED]');
    });
  });
});

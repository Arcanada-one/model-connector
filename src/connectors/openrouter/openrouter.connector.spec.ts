import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { OpenRouterConnector } from './openrouter.connector';

// CONN-0238 — live capture GET https://openrouter.ai/api/v1/models (public), arcana-dev
// 2026-06-23: all 340 entries (26 free), real ids + pricing + top_provider. Trimmed to
// the fields the parser reads. The catalog must surface ALL 340, not free-only.
const OPENROUTER_MODELS_FIXTURE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../..', 'test/fixtures/connectors/openrouter-models.json'),
    'utf8',
  ),
) as {
  data: Array<{
    id: string;
    context_length: number | null;
    pricing: { prompt: string | null; completion: string | null };
    top_provider: { context_length: number | null; max_completion_tokens: number | null };
  }>;
};

describe('OpenRouterConnector', () => {
  let connector: OpenRouterConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
    connector = new OpenRouterConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENROUTER_API_KEY;
  });

  // --- Fixtures (OpenRouter OpenAI-compatible response) ---

  const chatResponse = {
    id: 'gen-abc123',
    model: 'anthropic/claude-sonnet-4',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello! How can I help you?' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 8,
      total_tokens: 18,
    },
  };

  const chatResponseWithCost = {
    ...chatResponse,
    usage: {
      ...chatResponse.usage,
      total_cost: 0.00042,
    },
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
    it('should use OpenRouter chat completions endpoint', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      expect(fetchSpy.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    });
  });

  // --- Headers ---

  describe('headers', () => {
    it('should include Authorization and Content-Type', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Bearer sk-or-test-key');
    });
  });

  // --- Request body ---

  describe('buildRequestBody', () => {
    it('should build messages from prompt', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'What is 2+2?' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.messages).toEqual([{ role: 'user', content: 'What is 2+2?' }]);
    });

    it('should include systemPrompt as system message', async () => {
      mockOk(chatResponse);
      await connector.execute({
        prompt: 'hello',
        systemPrompt: 'You are a helpful assistant',
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'hello' },
      ]);
    });

    it('should use default model when not specified', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('anthropic/claude-sonnet-4');
    });

    it('should use request.model when specified', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello', model: 'openai/gpt-4o' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('openai/gpt-4o');
    });

    it('should pass max_tokens from extra', async () => {
      mockOk(chatResponse);
      await connector.execute({
        prompt: 'hello',
        extra: { max_tokens: 1000 },
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(1000);
    });

    it('should pass temperature from extra', async () => {
      mockOk(chatResponse);
      await connector.execute({
        prompt: 'hello',
        extra: { temperature: 0.7 },
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.7);
    });

    it('should include response_format when responseFormat is json_object', async () => {
      mockOk(chatResponse);
      await connector.execute({
        prompt: 'list items',
        responseFormat: { type: 'json_object' },
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('should NOT include response_format when responseFormat is text', async () => {
      mockOk(chatResponse);
      await connector.execute({
        prompt: 'hello',
        responseFormat: { type: 'text' },
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.response_format).toBeUndefined();
    });

    it('should NOT include response_format when not specified', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.response_format).toBeUndefined();
    });
  });

  // --- Response parsing ---

  describe('parseResponse', () => {
    it('should extract text from choices[0].message.content', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('success');
      expect(response.result).toBe('Hello! How can I help you?');
      expect(response.model).toBe('anthropic/claude-sonnet-4');
    });

    it('should extract token usage', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(8);
      expect(response.usage.totalTokens).toBe(18);
    });

    it('should use total_cost from OpenRouter when available', async () => {
      mockOk(chatResponseWithCost);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.usage.costUsd).toBe(0.00042);
    });

    it('should default costUsd to 0 when total_cost missing', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.usage.costUsd).toBe(0);
    });

    it('should handle empty choices gracefully', async () => {
      mockOk({ ...chatResponse, choices: [] });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('error');
      expect(response.result).toBe('');
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('should return auth_error on 401', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":{"message":"Invalid API key"}}'),
      });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('auth_error');
    });

    it('should return rate_limited on 429', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('rate limited'),
      });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('rate_limited');
      expect(response.error?.type).toBe('rate_limited');
    });

    it('should return error when API key not set', async () => {
      delete process.env.OPENROUTER_API_KEY;
      connector = new OpenRouterConnector();
      mockOk(chatResponse);
      // Auth header will be "Bearer undefined" — server would 401
      await connector.execute({ prompt: 'hello' });
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer ');
    });
  });

  // --- Config ---

  describe('configuration', () => {
    it('should use default timeout of 120s', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      // Can't directly assert AbortSignal timeout, but verifies no throw
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('should use OPENROUTER_TIMEOUT_MS from env', async () => {
      process.env.OPENROUTER_TIMEOUT_MS = '60000';
      connector = new OpenRouterConnector();
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      expect(fetchSpy).toHaveBeenCalledOnce();
      delete process.env.OPENROUTER_TIMEOUT_MS;
    });
  });

  // --- Capabilities ---

  describe('getCapabilities', () => {
    it('should return correct capability schema', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('openrouter');
      expect(caps.type).toBe('api');
      expect(caps.models).toContain('anthropic/claude-sonnet-4');
      expect(caps.models).toContain('openai/gpt-4o');
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.supportsJsonSchema).toBe(true);
      expect(caps.supportsTools).toBe(true);
      expect(caps.maxTimeout).toBe(300_000);
    });

    // CONN-0233 — free-detection: OpenRouter dynamic fetch
    it('should expose freeModels[] (empty before refreshFreeModels is called)', () => {
      const caps = connector.getCapabilities();
      // Before refresh: freeModels is defined as an empty array
      expect(Array.isArray(caps.freeModels)).toBe(true);
    });

    it('refreshFreeModels: parses pricing=0 models as free', async () => {
      // Fixture: 3 models — two free (pricing or :free suffix), one paid
      const modelsApiFixture = {
        data: [
          {
            id: 'google/gemma-4-31b-it:free',
            pricing: { prompt: '0', completion: '0' },
          },
          {
            id: 'nvidia/nemotron-3-nano:free',
            pricing: { prompt: '0', completion: '0' },
          },
          {
            id: 'openai/gpt-4o',
            pricing: { prompt: '0.0025', completion: '0.01' },
          },
        ],
      };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(modelsApiFixture),
      });

      await connector.refreshFreeModels();
      const caps = connector.getCapabilities();

      expect(caps.freeModels).toContain('google/gemma-4-31b-it:free');
      expect(caps.freeModels).toContain('nvidia/nemotron-3-nano:free');
      expect(caps.freeModels).not.toContain('openai/gpt-4o');
      // Free models must also appear in caps.models
      expect(caps.models).toContain('google/gemma-4-31b-it:free');
      expect(caps.models).toContain('nvidia/nemotron-3-nano:free');
      // CONN-0238 — paid models are surfaced too (all models, not free-only).
      expect(caps.models).toContain('openai/gpt-4o');
    });

    it('refreshFreeModels: treats :free-suffix models as free even if pricing missing', async () => {
      const modelsApiFixture = {
        data: [
          { id: 'some/model:free' }, // no pricing field
          { id: 'another/model', pricing: null }, // null pricing
        ],
      };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(modelsApiFixture),
      });

      await connector.refreshFreeModels();
      const caps = connector.getCapabilities();
      expect(caps.freeModels).toContain('some/model:free');
      expect(caps.freeModels).not.toContain('another/model');
    });

    it('refreshFreeModels: tolerates API failure gracefully (freeModels stays [])', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));

      await expect(connector.refreshFreeModels()).resolves.not.toThrow();
      const caps = connector.getCapabilities();
      expect(Array.isArray(caps.freeModels)).toBe(true);
    });
  });

  // CONN-0238 — surface ALL 340 (not free-only). free=true flags the 26 free; the
  // page can default to free-first via a filter, but the CATALOG carries all 340.
  // Per-model pricing/context come from the live /models entries.
  describe('CONN-0238 — all-340 + per-model free/pricing/context', () => {
    function mockModelsOk() {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(OPENROUTER_MODELS_FIXTURE),
      });
    }
    const metaFor = (caps: ReturnType<OpenRouterConnector['getCapabilities']>, id: string) =>
      (caps.modelMeta ?? []).find((m) => m.id === id);

    it('REPLACES with all 340 models (count matches the live fixture)', async () => {
      mockModelsOk();
      await connector.refreshFreeModels();
      const caps = connector.getCapabilities();
      expect(caps.models.length).toBe(OPENROUTER_MODELS_FIXTURE.data.length);
    });

    it('flags exactly the 26 free models (the rest are paid, still listed)', async () => {
      mockModelsOk();
      await connector.refreshFreeModels();
      const caps = connector.getCapabilities();
      const expectedFree = OPENROUTER_MODELS_FIXTURE.data.filter(
        (e) =>
          e.id.endsWith(':free') || (e.pricing?.prompt === '0' && e.pricing?.completion === '0'),
      ).length;
      expect((caps.freeModels ?? []).length).toBe(expectedFree);
      // and the paid majority is still present in models[]
      expect(caps.models.length).toBeGreaterThan((caps.freeModels ?? []).length);
    });

    it('surfaces real per-1M-token pricing + context for a paid model', async () => {
      mockModelsOk();
      await connector.refreshFreeModels();
      const caps = connector.getCapabilities();
      // pick the first paid entry that publishes numeric prompt+completion pricing
      const sample = OPENROUTER_MODELS_FIXTURE.data.find(
        (e) =>
          !e.id.endsWith(':free') &&
          e.pricing?.prompt &&
          e.pricing.prompt !== '0' &&
          e.pricing?.completion,
      )!;
      const m = metaFor(caps, sample.id);
      expect(m?.pricing?.unit).toBe('per_1m_tokens');
      expect(m?.pricing?.inputPerMTok).toBeCloseTo(Number(sample.pricing.prompt) * 1e6, 6);
      const expectedCtx = sample.top_provider?.context_length ?? sample.context_length ?? null;
      expect(m?.contextWindow).toBe(expectedCtx);
    });

    it('marks a :free model free in its per-model meta', async () => {
      mockModelsOk();
      await connector.refreshFreeModels();
      const caps = connector.getCapabilities();
      const freeSample = OPENROUTER_MODELS_FIXTURE.data.find((e) => e.id.endsWith(':free'))!;
      expect(metaFor(caps, freeSample.id)?.free).toBe(true);
    });
  });

  // --- ARCA-0011 multi-modal (ContentBlock[] prompt forwarding) ---

  describe('ARCA-0011 multimodal prompt forwarding', () => {
    const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

    it('forwards ContentBlock[] prompt as messages[user].content array', async () => {
      mockOk(chatResponse);
      await connector.execute({
        prompt: [
          { type: 'text', text: 'Describe this image.' },
          { type: 'image_url', image_url: { url: pngDataUrl } },
        ],
        model: 'anthropic/claude-sonnet-4',
      });
      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse((call[1] as { body: string }).body) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userMsg = body.messages.find((m) => m.role === 'user');
      expect(Array.isArray(userMsg?.content)).toBe(true);
      const content = userMsg!.content as Array<{ type: string }>;
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe('text');
      expect(content[1].type).toBe('image_url');
    });

    it('still forwards string prompt as plain string content (backward-compat)', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const call = fetchSpy.mock.calls[0];
      const body = JSON.parse((call[1] as { body: string }).body) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userMsg = body.messages.find((m) => m.role === 'user');
      expect(typeof userMsg?.content).toBe('string');
      expect(userMsg?.content).toBe('hello');
    });
  });

  // --- Status ---

  describe('getStatus', () => {
    it('should check OpenRouter API health', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const status = await connector.getStatus();
      expect(status.name).toBe('openrouter');
      expect(status.healthy).toBe(true);
    });
  });
});

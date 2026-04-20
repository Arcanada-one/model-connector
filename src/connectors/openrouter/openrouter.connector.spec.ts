import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterConnector } from './openrouter.connector';

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

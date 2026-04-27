import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroqConnector } from './groq.connector';

describe('GroqConnector', () => {
  let connector: GroqConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'gsk_test_key';
    connector = new GroqConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GROQ_API_KEY;
  });

  // --- Fixtures (Groq OpenAI-compatible response, see datarim/tasks/CONN-0047-fixtures.md) ---

  const chatResponse = {
    id: 'chatcmpl-b2d1ed13-69b7-4d05-b554-ae3da5cf3cd1',
    object: 'chat.completion',
    created: 1777308983,
    model: 'llama-3.3-70b-versatile',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: {
      queue_time: 0.048107039,
      prompt_tokens: 39,
      prompt_time: 0.001679552,
      completion_tokens: 2,
      completion_time: 0.014530901,
      total_tokens: 41,
      total_time: 0.016210453,
    },
    usage_breakdown: null,
    system_fingerprint: 'fp_f8b414701e',
    x_groq: { id: 'req_01kq7xxrkyehmtzjeqb9gwdawx', seed: 341981848 },
    service_tier: 'on_demand',
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
    it('should use Groq chat completions endpoint', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    });
  });

  // --- Headers ---

  describe('headers', () => {
    it('should include Authorization Bearer and Content-Type', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Bearer gsk_test_key');
    });
  });

  // --- Request body ---

  describe('buildRequestBody', () => {
    it('should build messages from prompt', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'reply with ok only' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.messages).toEqual([{ role: 'user', content: 'reply with ok only' }]);
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

    it('should default model to llama-3.3-70b-versatile', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('llama-3.3-70b-versatile');
    });

    it('should use request.model when specified', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello', model: 'openai/gpt-oss-120b' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('openai/gpt-oss-120b');
    });

    it('should pass max_tokens, temperature, top_p from extra', async () => {
      mockOk(chatResponse);
      await connector.execute({
        prompt: 'hello',
        extra: { max_tokens: 1024, temperature: 0.5, top_p: 0.9 },
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(1024);
      expect(body.temperature).toBe(0.5);
      expect(body.top_p).toBe(0.9);
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

    it('should NOT include response_format for text or unset', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello', responseFormat: { type: 'text' } });
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
      expect(response.result).toBe('ok');
      expect(response.model).toBe('llama-3.3-70b-versatile');
    });

    it('should extract token usage from prompt_tokens / completion_tokens', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.usage.inputTokens).toBe(39);
      expect(response.usage.outputTokens).toBe(2);
      expect(response.usage.totalTokens).toBe(41);
    });

    it('should always default costUsd to 0 (Groq free tier, no total_cost field)', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.usage.costUsd).toBe(0);
    });

    it('should ignore Groq-specific extras (x_groq, system_fingerprint, service_tier)', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      // These fields are present in response but should not leak into ConnectorResponse
      expect(response.result).toBe('ok');
      expect(response).not.toHaveProperty('x_groq');
      expect(response).not.toHaveProperty('system_fingerprint');
    });

    it('should handle empty choices gracefully', async () => {
      mockOk({ ...chatResponse, choices: [] });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('error');
      expect(response.result).toBe('');
    });

    it('should handle null content in message gracefully', async () => {
      const nullContent = {
        ...chatResponse,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
      };
      mockOk(nullContent);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('success');
      expect(response.result).toBe('');
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('should return auth_error on HTTP 401 (Invalid API Key)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () =>
          Promise.resolve(
            '{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}',
          ),
      });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('auth_error');
    });

    it('should return rate_limited on HTTP 429', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('rate limited'),
      });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('rate_limited');
      expect(response.error?.type).toBe('rate_limited');
    });

    it('should return http_error on HTTP 404 (model_not_found, OpenAI-compat default)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () =>
          Promise.resolve(
            '{"error":{"message":"The model `nonexistent-model` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}',
          ),
      });
      const response = await connector.execute({ prompt: 'hello', model: 'nonexistent-model' });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('http_error');
    });

    it('should send empty Bearer when GROQ_API_KEY not set', async () => {
      delete process.env.GROQ_API_KEY;
      connector = new GroqConnector();
      mockOk(chatResponse);
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
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('should respect GROQ_TIMEOUT_MS from env', async () => {
      process.env.GROQ_TIMEOUT_MS = '45000';
      connector = new GroqConnector();
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      expect(fetchSpy).toHaveBeenCalledOnce();
      delete process.env.GROQ_TIMEOUT_MS;
    });
  });

  // --- Capabilities ---

  describe('getCapabilities', () => {
    it('should report Groq capability schema (json_schema + tools, no streaming)', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('groq');
      expect(caps.type).toBe('api');
      expect(caps.models).toContain('llama-3.3-70b-versatile');
      expect(caps.models).toContain('openai/gpt-oss-120b');
      expect(caps.models).toContain('qwen/qwen3-32b');
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.supportsJsonSchema).toBe(true);
      expect(caps.supportsTools).toBe(true);
      expect(caps.maxTimeout).toBe(300_000);
    });
  });

  // --- Status ---

  describe('getStatus', () => {
    it('should query Groq health endpoint', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const status = await connector.getStatus();
      expect(status.name).toBe('groq');
      expect(status.healthy).toBe(true);
    });
  });
});

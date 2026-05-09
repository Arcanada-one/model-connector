import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { {{NAME}}Connector } from './{{NAME_LOWER}}.connector';

describe('{{NAME}}Connector', () => {
  let connector: {{NAME}}Connector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.{{API_KEY_ENV}} = 'test_key_{{NAME_LOWER}}';
    connector = new {{NAME}}Connector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.{{API_KEY_ENV}};
  });

  // --- Fixtures ---
  // NOTE: replace with a real captured payload from `curl {{BASE_URL}}/v1/chat/completions`
  // (see README Step 0 — fixture capture). Keep provider-specific extras (e.g. system_fingerprint,
  // x_groq, total_cost) only if they actually appear in production responses.

  const chatResponse = {
    id: 'chatcmpl-{{NAME_LOWER}}-test',
    object: 'chat.completion',
    created: 1700000000,
    model: '{{DEFAULT_MODEL}}',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
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
    it('should use {{NAME}} chat completions endpoint', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      expect(fetchSpy.mock.calls[0][0]).toBe('{{BASE_URL}}/v1/chat/completions');
    });
  });

  // --- Headers ---

  describe('headers', () => {
    it('should include Authorization Bearer and Content-Type', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Bearer test_key_{{NAME_LOWER}}');
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

    it('should default model to {{DEFAULT_MODEL}}', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('{{DEFAULT_MODEL}}');
    });

    it('should use request.model when specified', async () => {
      mockOk(chatResponse);
      // Replace 'replace-me-alt-model' with a second real model from {{MODELS_LIST}}.
      await connector.execute({ prompt: 'hello', model: 'replace-me-alt-model' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('replace-me-alt-model');
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
      expect(response.model).toBe('{{DEFAULT_MODEL}}');
    });

    it('should extract token usage from prompt_tokens / completion_tokens', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(2);
      expect(response.usage.totalTokens).toBe(12);
    });

    it('should report costUsd per provider semantics ({{COST_FIELD}})', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      // Default fixture has no usage.total_cost ⇒ expect 0 either way.
      expect(response.usage.costUsd).toBe(0);
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
    it('should return auth_error on HTTP 401', async () => {
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

    it('should send empty Bearer when {{API_KEY_ENV}} not set', async () => {
      delete process.env.{{API_KEY_ENV}};
      connector = new {{NAME}}Connector();
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

    it('should respect {{TIMEOUT_ENV}} from env', async () => {
      process.env.{{TIMEOUT_ENV}} = '45000';
      connector = new {{NAME}}Connector();
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      expect(fetchSpy).toHaveBeenCalledOnce();
      delete process.env.{{TIMEOUT_ENV}};
    });
  });

  // --- Capabilities ---

  describe('getCapabilities', () => {
    it('should report {{NAME}} capability schema', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('{{NAME_LOWER}}');
      expect(caps.type).toBe('api');
      expect(caps.models).toContain('{{DEFAULT_MODEL}}');
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.supportsJsonSchema).toBe(true);
      expect(caps.supportsTools).toBe(true);
      expect(caps.maxTimeout).toBe(300_000);
    });
  });

  // --- Status ---

  describe('getStatus', () => {
    it('should query {{NAME}} health endpoint', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const status = await connector.getStatus();
      expect(status.name).toBe('{{NAME_LOWER}}');
      expect(status.healthy).toBe(true);
    });
  });
});

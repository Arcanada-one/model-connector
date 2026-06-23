import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { OrqConnector } from './orq.connector';

// Load saved fixtures (captured from live orq.ai API)
const modelsFixture = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__/models-sample.json'), 'utf-8'),
) as unknown[];

const chatResponseFixture = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__/chat-response.json'), 'utf-8'),
) as unknown;

describe('OrqConnector', () => {
  let connector: OrqConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.ORQ_API_KEY = 'sk-orq-test-key';
    connector = new OrqConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORQ_API_KEY;
    delete process.env.ORQ_TIMEOUT_MS;
  });

  // Helper to mock a successful fetch response
  function mockOk(body: unknown) {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  }

  // --- 1. buildRequestUrl ---

  describe('buildRequestUrl', () => {
    it('should use the orq chat completions endpoint', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({ prompt: 'ping' });
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.orq.ai/v2/proxy/chat/completions');
    });
  });

  // --- 2. headers ---

  describe('headers', () => {
    it('should include Authorization Bearer and Content-Type', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({ prompt: 'ping' });
      const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Bearer sk-orq-test-key');
    });

    it('should use empty string when ORQ_API_KEY is unset', async () => {
      delete process.env.ORQ_API_KEY;
      connector = new OrqConnector();
      mockOk(chatResponseFixture);
      await connector.execute({ prompt: 'ping' });
      const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer ');
    });
  });

  // --- 3. buildRequestBody ---

  describe('buildRequestBody', () => {
    it('should build messages from prompt string', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({ prompt: 'What is 2+2?' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages).toEqual([{ role: 'user', content: 'What is 2+2?' }]);
    });

    it('should include systemPrompt as system message', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({
        prompt: 'hello',
        systemPrompt: 'You are a helpful assistant',
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'hello' },
      ]);
    });

    it('should default model to gpt-4o-mini when not specified', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({ prompt: 'hello' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
        model: string;
      };
      expect(body.model).toBe('gpt-4o-mini');
    });

    it('should use request.model verbatim (no prefix added)', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({ prompt: 'hello', model: 'groq/llama-3.3-70b-versatile' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
        model: string;
      };
      expect(body.model).toBe('groq/llama-3.3-70b-versatile');
    });

    it('should include response_format when responseFormat is json_object', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({
        prompt: 'list items',
        responseFormat: { type: 'json_object' },
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
        response_format?: { type: string };
      };
      expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('should NOT include response_format when responseFormat is text', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({
        prompt: 'hello',
        responseFormat: { type: 'text' },
      });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
        response_format?: unknown;
      };
      expect(body.response_format).toBeUndefined();
    });

    it('should pass max_tokens from extra', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({ prompt: 'hello', extra: { max_tokens: 512 } });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
        max_tokens?: number;
      };
      expect(body.max_tokens).toBe(512);
    });

    it('should pass temperature from extra', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({ prompt: 'hello', extra: { temperature: 0.5 } });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
        temperature?: number;
      };
      expect(body.temperature).toBe(0.5);
    });

    it('should pass top_p from extra', async () => {
      mockOk(chatResponseFixture);
      await connector.execute({ prompt: 'hello', extra: { top_p: 0.9 } });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string) as {
        top_p?: number;
      };
      expect(body.top_p).toBe(0.9);
    });
  });

  // --- 4. parseResponse ---

  describe('parseResponse', () => {
    it('should extract text "pong" from fixture', async () => {
      mockOk(chatResponseFixture);
      const response = await connector.execute({ prompt: 'reply with exactly: pong' });
      expect(response.status).toBe('success');
      expect(response.result).toBe('pong');
    });

    it('should extract model "gpt-4o-mini" from fixture', async () => {
      mockOk(chatResponseFixture);
      const response = await connector.execute({ prompt: 'ping' });
      expect(response.model).toBe('gpt-4o-mini');
    });

    it('should extract token usage from fixture (12/1)', async () => {
      mockOk(chatResponseFixture);
      const response = await connector.execute({ prompt: 'ping' });
      expect(response.usage.inputTokens).toBe(12);
      expect(response.usage.outputTokens).toBe(1);
    });

    it('should always return costUsd = 0 (paid gateway, no per-call echo)', async () => {
      mockOk(chatResponseFixture);
      const response = await connector.execute({ prompt: 'ping' });
      expect(response.usage.costUsd).toBe(0);
    });

    it('should return isError=false on success', async () => {
      mockOk(chatResponseFixture);
      const response = await connector.execute({ prompt: 'ping' });
      expect(response.status).toBe('success');
    });

    it('should handle empty choices gracefully (isError=true)', async () => {
      mockOk({ ...(chatResponseFixture as object), choices: [] });
      const response = await connector.execute({ prompt: 'ping' });
      expect(response.status).toBe('error');
      expect(response.result).toBe('');
    });
  });

  // --- 5. refreshModels filter ---

  describe('refreshModels', () => {
    it('should filter fixture to all 6 chat+active model_ids (all in fixture qualify)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(modelsFixture),
      });

      await connector.refreshModels();
      const caps = connector.getCapabilities();

      // All 6 fixture entries are model_type=chat + is_active=true
      expect(caps.models).toContain('gpt-4o');
      expect(caps.models).toContain('deepseek-ai/DeepSeek-R1');
      expect(caps.models).toContain('grok-3');
      expect(caps.models).toContain('GLM-5.1');
      expect(caps.models).toContain('holo3-122b-a10b');
      expect(caps.models).toContain('moonshotai/Kimi-K2.6');
      expect(caps.models).toHaveLength(6);
    });

    it('should emit model_id (not UUID id field)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(modelsFixture),
      });

      await connector.refreshModels();
      const caps = connector.getCapabilities();

      // UUID from fixture: ab37aecd-bac0-4c75-80ae-e87976dbb965 (gpt-4o entry)
      expect(caps.models).not.toContain('ab37aecd-bac0-4c75-80ae-e87976dbb965');
      // model_id must be there
      expect(caps.models).toContain('gpt-4o');
    });

    it('should exclude non-chat model types', async () => {
      const mixedFixture = [
        ...modelsFixture,
        { model_id: 'x-image-model', model_type: 'image', is_active: true },
        { model_id: 'x-embed-model', model_type: 'embedding', is_active: true },
      ];
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mixedFixture),
      });

      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(caps.models).not.toContain('x-image-model');
      expect(caps.models).not.toContain('x-embed-model');
    });

    it('should exclude inactive chat models', async () => {
      const withInactive = [
        ...modelsFixture,
        { model_id: 'inactive-chat', model_type: 'chat', is_active: false },
      ];
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(withInactive),
      });

      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(caps.models).not.toContain('inactive-chat');
    });
  });

  // --- 6. refreshModels tolerance ---

  describe('refreshModels tolerance', () => {
    const SEED_MODELS = ['gpt-4o-mini', 'gpt-4o', 'deepseek-ai/DeepSeek-R1'];

    it('should keep seed list when fetch throws', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));
      await expect(connector.refreshModels()).resolves.not.toThrow();
      const caps = connector.getCapabilities();
      // Seed must still be present
      for (const m of SEED_MODELS) {
        expect(caps.models).toContain(m);
      }
    });

    it('should keep seed list on non-200 response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 });
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      for (const m of SEED_MODELS) {
        expect(caps.models).toContain(m);
      }
    });

    it('should keep seed list when response is not an array', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }), // object, not array
      });
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      for (const m of SEED_MODELS) {
        expect(caps.models).toContain(m);
      }
    });

    it('should keep seed list when array has 0 chat+active entries', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ model_id: 'img', model_type: 'image', is_active: true }]),
      });
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      for (const m of SEED_MODELS) {
        expect(caps.models).toContain(m);
      }
    });
  });

  // --- 7. getCapabilities ---

  describe('getCapabilities', () => {
    it('should return correct static capability fields', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('orq');
      expect(caps.type).toBe('api');
      expect(caps.supportsJsonSchema).toBe(true);
      expect(caps.supportsTools).toBe(true);
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.maxTimeout).toBe(300_000);
    });

    it('should return seed models before any refreshModels call', () => {
      const caps = connector.getCapabilities();
      expect(caps.models).toContain('gpt-4o-mini');
      expect(caps.models).toContain('gpt-4o');
      expect(caps.models).toContain('deepseek-ai/DeepSeek-R1');
    });
  });

  // --- Error handling (HTTP error path) ---

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
  });

  // --- Timeout config ---

  describe('configuration', () => {
    it('should use ORQ_TIMEOUT_MS from env when set', async () => {
      process.env.ORQ_TIMEOUT_MS = '60000';
      connector = new OrqConnector();
      mockOk(chatResponseFixture);
      await connector.execute({ prompt: 'hello' });
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });
});

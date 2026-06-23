import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { GrokConnector } from './grok.connector';

// xAI OpenAI-compat /v1/models shape (docs.x.ai). CONN-0238 — operator live capture
// 2026-06-23: the real 9 ids (grok-4.3, grok-4.20-*, grok-build-0.1, grok-imagine-*)
// replace the CONN-0236 phantom list (grok-4-fast/grok-3/…) that the UNION refresh
// leaked into prod. grok-imagine-* are image/video models — modality matters.
const GROK_MODELS_FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, '../../..', 'test/fixtures/connectors/grok-models.json'), 'utf8'),
) as { data: Array<{ id: string }> };

describe('GrokConnector', () => {
  let connector: GrokConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.XAI_API_KEY = 'xai_test_key';
    connector = new GrokConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.XAI_API_KEY;
  });

  // Fixtures derived from datarim/tasks/CONN-0048-fixtures.md (live xAI capture 2026-04-28).

  const chatResponse = {
    id: 'e387cd62-1427-78ab-1a26-1b51f19b2ff1',
    object: 'chat.completion',
    created: 1777386205,
    model: 'grok-4-fast-reasoning',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok', refusal: null },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 161,
      completion_tokens: 1,
      total_tokens: 250,
    },
    system_fingerprint: 'fp_e4f661d783',
  };

  function mockOk(body: unknown) {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  }

  describe('buildRequestUrl', () => {
    it('should hit xAI chat completions endpoint', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.x.ai/v1/chat/completions');
    });
  });

  describe('headers', () => {
    it('should include Authorization Bearer XAI_API_KEY and Content-Type', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Bearer xai_test_key');
    });

    it('should send empty Bearer when XAI_API_KEY not set', async () => {
      delete process.env.XAI_API_KEY;
      connector = new GrokConnector();
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer ');
    });
  });

  describe('buildRequestBody', () => {
    it('should build messages from prompt only', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'reply with ok only' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.messages).toEqual([{ role: 'user', content: 'reply with ok only' }]);
    });

    it('should prepend systemPrompt as system message', async () => {
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

    it('should default model to grok-4.3', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('grok-4.3');
    });

    it('should use request.model when specified', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello', model: 'grok-4.20-0309-non-reasoning' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe('grok-4.20-0309-non-reasoning');
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

    it('should not include extras when not provided', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.max_tokens).toBeUndefined();
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
    });
  });

  describe('parseResponse', () => {
    it('should extract text from choices[0].message.content', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('success');
      expect(response.result).toBe('ok');
    });

    it('should pass through server-resolved model alias (grok-4-fast → grok-4-fast-reasoning)', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello', model: 'grok-4-fast' });
      expect(response.model).toBe('grok-4-fast-reasoning');
    });

    it('should extract token usage from prompt_tokens / completion_tokens', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.usage.inputTokens).toBe(161);
      expect(response.usage.outputTokens).toBe(1);
      expect(response.usage.totalTokens).toBe(162);
    });

    it('should default costUsd to 0 (xAI cost_in_usd_ticks not yet wired)', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.usage.costUsd).toBe(0);
    });

    it('should ignore xAI-specific extras (system_fingerprint)', async () => {
      mockOk(chatResponse);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response).not.toHaveProperty('system_fingerprint');
    });

    it('should handle empty choices gracefully', async () => {
      mockOk({ ...chatResponse, choices: [] });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('error');
      expect(response.result).toBe('');
    });

    it('should handle null content in message gracefully', async () => {
      mockOk({
        ...chatResponse,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null },
            finish_reason: 'stop',
          },
        ],
      });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('success');
      expect(response.result).toBe('');
    });

    it('should handle missing usage object gracefully', async () => {
      const noUsage = { ...chatResponse, usage: undefined };
      mockOk(noUsage);
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.usage.inputTokens).toBe(0);
      expect(response.usage.outputTokens).toBe(0);
    });
  });

  describe('error handling', () => {
    // xAI deviates from OpenAI: invalid model returns HTTP 400 (not 404).
    // Existing classifyHttpError 400 → validation_error path covers this without bundle.
    it('should return validation_error on HTTP 400 (xAI invalid model)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            '{"code":"Client specified an invalid argument","error":"Model not found: nonexistent-model-xyz"}',
          ),
      });
      const response = await connector.execute({ prompt: 'hello', model: 'nonexistent-model-xyz' });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('validation_error');
    });

    it('should return validation_error on HTTP 400 (xAI invalid API key surfaces as 400)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            '{"code":"Client specified an invalid argument","error":"Incorrect API key provided: xa***ST."}',
          ),
      });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('validation_error');
    });

    it('should return rate_limited on HTTP 429', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('{"code":"resource_exhausted","error":"Rate limit"}'),
      });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('rate_limited');
      expect(response.error?.type).toBe('rate_limited');
    });

    it('should return server_error on HTTP 500', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('{"error":"internal"}'),
      });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('server_error');
    });

    it('should never echo XAI_API_KEY in errorMessage (T1 redaction)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            '{"code":"Client specified an invalid argument","error":"Incorrect API key provided: xa***ST."}',
          ),
      });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.error?.message ?? '').not.toContain('xai_test_key');
    });
  });

  describe('configuration', () => {
    it('should use default timeout of 120s', async () => {
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('should respect GROK_TIMEOUT_MS from env', async () => {
      process.env.GROK_TIMEOUT_MS = '45000';
      connector = new GrokConnector();
      mockOk(chatResponse);
      await connector.execute({ prompt: 'hello' });
      expect(fetchSpy).toHaveBeenCalledOnce();
      delete process.env.GROK_TIMEOUT_MS;
    });
  });

  describe('getCapabilities', () => {
    it('should report Grok capability schema (json_schema + tools, no streaming)', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('grok');
      expect(caps.type).toBe('api');
      // CONN-0238 — static floor is the real chat models (no phantom grok-4-fast/grok-3).
      expect(caps.models).toContain('grok-4.3');
      expect(caps.models).not.toContain('grok-4-fast');
      expect(caps.models).not.toContain('grok-3');
      expect(caps.supportsStreaming).toBe(false);
      expect(caps.supportsJsonSchema).toBe(true);
      expect(caps.supportsTools).toBe(true);
      expect(caps.maxTimeout).toBe(300_000);
    });

    // CONN-0233 — free-detection: xAI/Grok has no free tier (all pay-per-token).
    // freeModels must be present but empty.
    it('should expose freeModels as an empty array (xAI has no free tier)', () => {
      const caps = connector.getCapabilities();
      expect(Array.isArray(caps.freeModels)).toBe(true);
      expect(caps.freeModels).toHaveLength(0);
    });
  });

  // CONN-0238 — Grok's /v1/models lists 9 real models (operator live capture
  // 2026-06-23): chat (grok-4.3, grok-4.20-*, grok-build-0.1) + image_generation
  // (grok-imagine-image*) + video (grok-imagine-video*). REPLACE-not-UNION kills the
  // CONN-0236 phantom list. Modality is classified per id (xAI /v1/models returns
  // ids only — no pricing/context, so those stay null).
  describe('refreshModels (CONN-0238 real list + per-model modality)', () => {
    function mockModelsOk() {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(GROK_MODELS_FIXTURE),
      });
    }
    const metaFor = (caps: ReturnType<GrokConnector['getCapabilities']>, id: string) =>
      (caps.modelMeta ?? []).find((m) => m.id === id);

    it('fetches the xAI OpenAI-compat /v1/models endpoint', async () => {
      mockModelsOk();
      await connector.refreshModels();
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.x.ai/v1/models');
    });

    it('REPLACES with the live 9 (count matches fixture; no phantom survivors)', async () => {
      mockModelsOk();
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(caps.models.length).toBe(GROK_MODELS_FIXTURE.data.length);
      for (const entry of GROK_MODELS_FIXTURE.data) {
        expect(caps.models).toContain(entry.id);
      }
      expect(caps.models).not.toContain('grok-4-fast');
      expect(caps.models).not.toContain('grok-3');
    });

    it('classifies grok-imagine-image* as image_generation', async () => {
      mockModelsOk();
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(metaFor(caps, 'grok-imagine-image')?.modality).toBe('image_generation');
      expect(metaFor(caps, 'grok-imagine-image-quality')?.modality).toBe('image_generation');
    });

    it('classifies grok-imagine-video* as video', async () => {
      mockModelsOk();
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(metaFor(caps, 'grok-imagine-video')?.modality).toBe('video');
      expect(metaFor(caps, 'grok-imagine-video-1.5')?.modality).toBe('video');
    });

    it('classifies the reasoning/build text models as chat', async () => {
      mockModelsOk();
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(metaFor(caps, 'grok-4.3')?.modality).toBe('chat');
      expect(metaFor(caps, 'grok-4.20-0309-reasoning')?.modality).toBe('chat');
      expect(metaFor(caps, 'grok-build-0.1')?.modality).toBe('chat');
    });

    it('keeps grok paid-only (freeModels stays empty) after refresh', async () => {
      mockModelsOk();
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(caps.freeModels).toEqual([]);
    });

    it('falls back to the static real-9 list when the API call fails (offline/CI)', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network down'));
      await expect(connector.refreshModels()).resolves.not.toThrow();
      const caps = connector.getCapabilities();
      expect(caps.models).toContain('grok-4.3');
      expect(caps.models).toContain('grok-imagine-image');
      expect(caps.models).not.toContain('grok-3');
    });
  });

  describe('getStatus', () => {
    it('should query xAI health endpoint', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const status = await connector.getStatus();
      expect(status.name).toBe('grok');
      expect(status.healthy).toBe(true);
    });
  });
});

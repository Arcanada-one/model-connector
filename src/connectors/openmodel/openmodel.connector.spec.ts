import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { OpenModelConnector } from './openmodel.connector';

// __dirname = code/src/connectors/openmodel → ../../.. = code/
const MODELS_FIXTURE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../..', 'test/fixtures/connectors/openmodel-models.json'),
    'utf8',
  ),
) as { data: Array<{ id: string }> };

// Prevent real HTTP calls in tests
vi.stubGlobal('fetch', vi.fn());

// Live-fixture shape (CONN-0223 smoke test, 2026-06-21):
//   POST https://api.openmodel.ai/v1/messages → 200
//   Response includes optional 'thinking' block before 'text' block.
const LIVE_RESPONSE_FIXTURE = {
  id: 'msg_live_01',
  type: 'message',
  role: 'assistant',
  model: 'deepseek-v4-flash',
  content: [
    { type: 'thinking', thinking: 'Let me think...' },
    { type: 'text', text: 'PONG' },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 4 },
};

// Minimal fixture — text-only content (no thinking block).
const TEXT_ONLY_FIXTURE = {
  id: 'msg_text_01',
  type: 'message',
  role: 'assistant',
  model: 'deepseek-v4-flash',
  content: [{ type: 'text', text: 'Hello!' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe('OpenModelConnector', () => {
  let connector: OpenModelConnector;

  beforeEach(() => {
    connector = new OpenModelConnector();
    vi.clearAllMocks();
    delete process.env.OPENMODEL_API_KEY;
    delete process.env.OPENMODEL_BASE_URL;
    delete process.env.OPENMODEL_TIMEOUT_MS;
    delete process.env.OPENMODEL_FREE_MODELS;
  });

  it('has name === "openmodel"', () => {
    expect(connector.name).toBe('openmodel');
  });

  // --- Protocol: URL ---

  it('builds /messages URL (Anthropic protocol, not /chat/completions)', () => {
    const url = (
      connector as unknown as { buildRequestUrl: (r: unknown) => string }
    ).buildRequestUrl({ model: 'deepseek-v4-flash', prompt: 'ping' });
    expect(url).toBe('https://api.openmodel.ai/v1/messages');
    // Guard: must NOT point at the OpenAI-compat endpoint (would 404 on live provider)
    expect(url).not.toContain('chat/completions');
  });

  it('uses OPENMODEL_BASE_URL when set', () => {
    process.env.OPENMODEL_BASE_URL = 'https://custom.api/v1';
    const url = (
      connector as unknown as { buildRequestUrl: (r: unknown) => string }
    ).buildRequestUrl({ model: 'x', prompt: 'y' });
    expect(url).toBe('https://custom.api/v1/messages');
  });

  // --- Protocol: Headers ---

  it('sends x-api-key header (not Authorization: Bearer)', () => {
    process.env.OPENMODEL_API_KEY = 'test-key';
    const headers = (
      connector as unknown as { getHeaders: () => Record<string, string> }
    ).getHeaders();
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
  });

  it('sends anthropic-version header', () => {
    const headers = (
      connector as unknown as { getHeaders: () => Record<string, string> }
    ).getHeaders();
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends content-type: application/json', () => {
    const headers = (
      connector as unknown as { getHeaders: () => Record<string, string> }
    ).getHeaders();
    expect(headers['content-type']).toBe('application/json');
  });

  // --- Protocol: Request body ---

  it('uses timeout', () => {
    process.env.OPENMODEL_TIMEOUT_MS = '45000';
    const timeout = (connector as unknown as { getTimeout: () => number }).getTimeout();
    expect(timeout).toBe(45_000);
  });

  it('defaults timeout to 30000', () => {
    const timeout = (connector as unknown as { getTimeout: () => number }).getTimeout();
    expect(timeout).toBe(30_000);
  });

  describe('buildRequestBody', () => {
    it('includes user message in messages array', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello world',
        model: 'deepseek-v4-flash',
      }) as { messages: Array<{ role: string; content: string }>; model: string };
      expect(body.messages).toContainEqual({ role: 'user', content: 'Hello world' });
      expect(body.model).toBe('deepseek-v4-flash');
    });

    it('puts system prompt as top-level system field (NOT in messages array)', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
        systemPrompt: 'You are helpful',
      }) as { system?: string; messages: Array<{ role: string; content: string }> };
      // system must be a top-level field per Anthropic protocol
      expect(body.system).toBe('You are helpful');
      // messages must NOT contain a system-role entry
      const systemMsg = body.messages.find((m) => m.role === 'system');
      expect(systemMsg).toBeUndefined();
    });

    it('omits system field when no systemPrompt', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
      }) as { system?: string };
      expect(body.system).toBeUndefined();
    });

    it('always includes max_tokens (required by Anthropic protocol)', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
      }) as { max_tokens: number };
      expect(typeof body.max_tokens).toBe('number');
      expect(body.max_tokens).toBeGreaterThan(0);
    });

    it('uses extra.max_tokens when provided', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
        extra: { max_tokens: 512 },
      }) as { max_tokens: number };
      expect(body.max_tokens).toBe(512);
    });

    it('uses default model when none provided', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
      }) as { model: string };
      expect(body.model).toBe('deepseek-v4-flash');
    });

    it('passes temperature from extra', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
        extra: { temperature: 0.3 },
      }) as { temperature?: number };
      expect(body.temperature).toBe(0.3);
    });

    it('does NOT include response_format (not part of Anthropic protocol)', () => {
      // OpenAI response_format is not valid for Anthropic /messages endpoint
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
        responseFormat: { type: 'json_object' },
      }) as { response_format?: unknown };
      expect(body.response_format).toBeUndefined();
    });

    // CONN-0237 — V-AC-1: JSON-mode body shape
    it('adds system JSON instruction AND assistant-prefill message when responseFormat.type is json_object', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Give me JSON',
        systemPrompt: 'You are helpful',
        responseFormat: { type: 'json_object' },
      }) as {
        system?: string;
        messages: Array<{ role: string; content: string }>;
        response_format?: unknown;
      };

      // system must contain the strict JSON instruction
      expect(body.system).toBeDefined();
      expect(body.system!.toLowerCase()).toContain('respond with only valid json');
      expect(body.system!.toLowerCase()).toContain('no markdown');

      // system must also preserve the original systemPrompt (merge, not replace)
      expect(body.system).toContain('You are helpful');

      // last message must be the assistant prefill
      const lastMsg = body.messages[body.messages.length - 1];
      expect(lastMsg).toEqual({ role: 'assistant', content: '{' });

      // user message must still be present
      expect(body.messages).toContainEqual({ role: 'user', content: 'Give me JSON' });

      // must NOT add OpenAI response_format field
      expect(body.response_format).toBeUndefined();
    });

    it('adds system JSON instruction without leading newline when no systemPrompt', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Give me JSON',
        responseFormat: { type: 'json_object' },
      }) as { system?: string; messages: Array<{ role: string; content: string }> };

      // system must equal only the instruction (no leading newline, no "undefined" string)
      expect(body.system).toBeDefined();
      expect(body.system).not.toMatch(/^undefined/);
      expect(body.system).not.toMatch(/^\n/);
      expect(body.system!.toLowerCase()).toContain('respond with only valid json');

      // prefill present
      const lastMsg = body.messages[body.messages.length - 1];
      expect(lastMsg).toEqual({ role: 'assistant', content: '{' });
    });

    // CONN-0237 — V-AC-2: Non-JSON byte-identity regression
    it('leaves request body byte-identical for non-json callers (no responseFormat)', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
        systemPrompt: 'sys',
        extra: { temperature: 0.3, max_tokens: 512 },
      }) as {
        system?: string;
        messages: Array<{ role: string; content: string }>;
        temperature?: number;
      };

      // system unchanged — no JSON instruction appended
      expect(body.system).toBe('sys');
      // no assistant-role prefill entry
      expect(body.messages.some((m) => m.role === 'assistant')).toBe(false);
      // temperature still passed through
      expect(body.temperature).toBe(0.3);
    });

    it('leaves request body byte-identical for non-json callers (responseFormat: type text)', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
        systemPrompt: 'sys',
        responseFormat: { type: 'text' },
      }) as {
        system?: string;
        messages: Array<{ role: string; content: string }>;
      };

      expect(body.system).toBe('sys');
      expect(body.messages.some((m) => m.role === 'assistant')).toBe(false);
    });
  });

  // --- Protocol: Response parsing ---

  describe('parseResponse', () => {
    it('extracts text from live fixture with thinking block preceding text block', () => {
      // This is the real live response shape: thinking block comes first.
      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(LIVE_RESPONSE_FIXTURE, { prompt: 'ping', model: 'deepseek-v4-flash' }) as {
        text: string;
        costUsd: number;
        isError: boolean;
        inputTokens: number;
        outputTokens: number;
      };
      expect(result.text).toBe('PONG');
      expect(result.isError).toBe(false);
      expect(result.costUsd).toBe(0); // Free tier always zero
      expect(result.inputTokens).toBe(12);
      expect(result.outputTokens).toBe(4);
    });

    it('extracts text from text-only content (no thinking block)', () => {
      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(TEXT_ONLY_FIXTURE, { prompt: 'hi', model: 'deepseek-v4-flash' }) as {
        text: string;
        isError: boolean;
        inputTokens: number;
        outputTokens: number;
      };
      expect(result.text).toBe('Hello!');
      expect(result.isError).toBe(false);
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
    });

    it('returns error when content has no text block', () => {
      const noTextJson = {
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-v4-flash',
        content: [{ type: 'thinking', thinking: 'Only thinking, no text' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 0 },
      };
      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(noTextJson, { prompt: 'hi' }) as { isError: boolean; errorMessage: string };
      expect(result.isError).toBe(true);
      expect(result.errorMessage).toMatch(/No text block/);
    });

    it('returns error when content array is empty', () => {
      const emptyContent = {
        id: 'msg_e',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-v4-flash',
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 0 },
      };
      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(emptyContent, { prompt: 'hi' }) as { isError: boolean };
      expect(result.isError).toBe(true);
    });

    it('maps usage.input_tokens and usage.output_tokens (Anthropic field names)', () => {
      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(LIVE_RESPONSE_FIXTURE, { prompt: 'hi', model: 'deepseek-v4-flash' }) as {
        inputTokens: number;
        outputTokens: number;
      };
      // Must use Anthropic field names (input_tokens / output_tokens),
      // NOT OpenAI names (prompt_tokens / completion_tokens).
      expect(result.inputTokens).toBe(12);
      expect(result.outputTokens).toBe(4);
    });

    it('costUsd is always 0 (free tier)', () => {
      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(LIVE_RESPONSE_FIXTURE, { prompt: 'hi' }) as { costUsd: number };
      expect(result.costUsd).toBe(0);
    });

    // CONN-0237 — V-AC-3: parseResponse re-prepend
    // The Anthropic /v1/messages API echoes ONLY the continuation of an assistant
    // prefill — the leading `{` is NOT returned. So parseResponse must re-prepend it.
    it('re-prepends leading { and returns parseable JSON when json-mode was active (nested object)', () => {
      const continuationFixture = {
        id: 'msg_json_01',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-v4-flash',
        content: [{ type: 'text', text: '"foo": 1, "nested": { "a": 2 } }' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      };

      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(continuationFixture, {
        prompt: 'x',
        responseFormat: { type: 'json_object' },
      }) as { text: string; isError: boolean };

      expect(result.isError).toBe(false);
      // After re-prepend the text must start with { and be parseable
      expect(result.text).toBe('{"foo": 1, "nested": { "a": 2 } }');
      expect(() => JSON.parse(result.text)).not.toThrow();
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.foo).toBe(1);
      expect((parsed.nested as Record<string, unknown>).a).toBe(2);
    });

    it('re-prepends leading { and returns parseable JSON when json-mode was active (flat object)', () => {
      const flatContinuationFixture = {
        id: 'msg_json_02',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-v4-flash',
        content: [{ type: 'text', text: '"key": "value", "count": 42 }' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 10 },
      };

      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(flatContinuationFixture, {
        prompt: 'y',
        responseFormat: { type: 'json_object' },
      }) as { text: string; isError: boolean };

      expect(result.isError).toBe(false);
      expect(result.text).toBe('{"key": "value", "count": 42 }');
      expect(() => JSON.parse(result.text)).not.toThrow();
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(parsed.key).toBe('value');
      expect(parsed.count).toBe(42);
    });

    it('does NOT double-prepend { when the upstream already returned a full object (CONN-0237 prod regression)', () => {
      // deepseek-v4-flash via the openmodel endpoint ignores the prefill and returns
      // the FULL object including the leading '{'. Re-prepending would yield '{{...}'
      // and JSON.parse would fail. Guard: only prepend when '{' is absent.
      const fullObjectFixture = {
        id: 'msg_json_03',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-v4-flash',
        content: [{ type: 'text', text: '{"ok": true}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 6 },
      };

      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(fullObjectFixture, {
        prompt: 'y',
        responseFormat: { type: 'json_object' },
      }) as { text: string; isError: boolean };

      expect(result.isError).toBe(false);
      expect(result.text).toBe('{"ok": true}');
      expect(result.text.startsWith('{{')).toBe(false);
      expect(() => JSON.parse(result.text)).not.toThrow();
      expect((JSON.parse(result.text) as { ok: boolean }).ok).toBe(true);
    });

    it('does NOT double-prepend { when full object has leading whitespace', () => {
      const paddedFixture = {
        id: 'msg_json_04',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-v4-flash',
        content: [{ type: 'text', text: '  {"a": 1}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 4 },
      };

      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(paddedFixture, {
        prompt: 'y',
        responseFormat: { type: 'json_object' },
      }) as { text: string; isError: boolean };

      expect(result.text.trimStart().startsWith('{{')).toBe(false);
      expect(() => JSON.parse(result.text)).not.toThrow();
    });

    it('does NOT re-prepend { when json-mode is inactive (type: text)', () => {
      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(TEXT_ONLY_FIXTURE, {
        prompt: 'hi',
        responseFormat: { type: 'text' },
      }) as { text: string; isError: boolean };

      expect(result.isError).toBe(false);
      expect(result.text).toBe('Hello!');
    });

    it('does NOT re-prepend { when json-mode is inactive (no responseFormat)', () => {
      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(TEXT_ONLY_FIXTURE, { prompt: 'hi' }) as { text: string; isError: boolean };

      expect(result.isError).toBe(false);
      expect(result.text).toBe('Hello!');
    });
  });

  describe('getCapabilities', () => {
    it('returns name=openmodel and type=api', () => {
      const caps = connector.getCapabilities();
      expect(caps.name).toBe('openmodel');
      expect(caps.type).toBe('api');
    });

    it('includes freeModels with deepseek-v4-flash by default', () => {
      const caps = connector.getCapabilities();
      expect((caps as unknown as { freeModels: string[] }).freeModels).toContain(
        'deepseek-v4-flash',
      );
    });

    it('uses OPENMODEL_FREE_MODELS CSV override', () => {
      process.env.OPENMODEL_FREE_MODELS = 'custom-model-a,custom-model-b';
      const caps = connector.getCapabilities();
      expect((caps as unknown as { freeModels: string[] }).freeModels).toEqual([
        'custom-model-a',
        'custom-model-b',
      ]);
    });
  });

  // CONN-0238 — openmodel /v1/models returns 34 real models (operator live capture
  // 2026-06-23). REPLACE-not-UNION: a successful refresh shows ONLY the live list,
  // so the dead static ids (deepseek-r2, qwen3-235b — gone from the live API) cannot
  // survive. The static floor itself is trimmed to the one cited live id.
  describe('refreshModels (CONN-0238 REPLACE + dead-id drop)', () => {
    function mockModelsOk(body: unknown) {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      });
    }

    it('fetches the OpenModel /models endpoint (Anthropic-compat list)', async () => {
      mockModelsOk(MODELS_FIXTURE);
      await connector.refreshModels();
      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledUrl).toBe('https://api.openmodel.ai/v1/models');
    });

    it('uses Authorization: Bearer for /models, not x-api-key (CONN-0236 — /v1/models 401s on x-api-key)', async () => {
      process.env.OPENMODEL_API_KEY = 'test-key';
      mockModelsOk(MODELS_FIXTURE);
      await connector.refreshModels();
      const opts = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(opts.headers['Authorization']).toBe('Bearer test-key');
      expect(opts.headers['x-api-key']).toBeUndefined();
    });

    it('before refresh, getCapabilities().models is the trimmed static floor (no dead ids)', () => {
      const caps = connector.getCapabilities();
      expect(caps.models).toEqual(['deepseek-v4-flash']);
      expect(caps.models).not.toContain('deepseek-r2');
      expect(caps.models).not.toContain('qwen3-235b');
    });

    it('after refresh, getCapabilities().models REPLACES with the full live 34', async () => {
      mockModelsOk(MODELS_FIXTURE);
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(caps.models.length).toBe(MODELS_FIXTURE.data.length);
      expect(caps.models).toContain('deepseek-v4-flash');
      expect(caps.models).toContain('claude-opus-4-8');
      expect(caps.models).toContain('gpt-5.4-pro');
      expect(caps.models).toContain('kimi-k2.7-code');
      expect(caps.models).toContain('qwen3.7-max');
    });

    it('REPLACE drops the dead static ids (no deepseek-r2 / qwen3-235b after refresh)', async () => {
      mockModelsOk(MODELS_FIXTURE);
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(caps.models).not.toContain('deepseek-r2');
      expect(caps.models).not.toContain('qwen3-235b');
    });

    it('does not duplicate ids', async () => {
      mockModelsOk(MODELS_FIXTURE);
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(caps.models.length).toBe(new Set(caps.models).size);
    });

    it('falls back to the trimmed static floor when the API call fails (offline/CI)', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('network down'),
      );
      await expect(connector.refreshModels()).resolves.not.toThrow();
      const caps = connector.getCapabilities();
      expect(caps.models).toEqual(['deepseek-v4-flash']);
    });

    it('falls back to the trimmed static floor on a non-2xx response', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
      });
      await connector.refreshModels();
      const caps = connector.getCapabilities();
      expect(caps.models).toEqual(['deepseek-v4-flash']);
    });
  });

  describe('classifyHttpError', () => {
    it('returns rate_limited for 429', () => {
      const result = (
        connector as unknown as { classifyHttpError: (s: number, b: string) => string }
      ).classifyHttpError(429, '');
      expect(result).toBe('rate_limited');
    });

    it('returns server_error for 500', () => {
      const result = (
        connector as unknown as { classifyHttpError: (s: number, b: string) => string }
      ).classifyHttpError(500, '');
      expect(result).toBe('server_error');
    });

    it('returns auth_error for 401', () => {
      const result = (
        connector as unknown as { classifyHttpError: (s: number, b: string) => string }
      ).classifyHttpError(401, '');
      expect(result).toBe('auth_error');
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenModelConnector } from './openmodel.connector';

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

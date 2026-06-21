import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenModelConnector } from './openmodel.connector';

// Prevent real HTTP calls in tests
vi.stubGlobal('fetch', vi.fn());

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

  it('uses default base URL when env not set', () => {
    const url = (
      connector as unknown as { buildRequestUrl: (r: unknown) => string }
    ).buildRequestUrl({ model: 'x', prompt: 'y' });
    expect(url).toBe('https://api.openmodel.ai/v1/chat/completions');
  });

  it('uses OPENMODEL_BASE_URL when set', () => {
    process.env.OPENMODEL_BASE_URL = 'https://custom.api/v1';
    const url = (
      connector as unknown as { buildRequestUrl: (r: unknown) => string }
    ).buildRequestUrl({ model: 'x', prompt: 'y' });
    expect(url).toBe('https://custom.api/v1/chat/completions');
  });

  it('uses OPENMODEL_TIMEOUT_MS when set', () => {
    process.env.OPENMODEL_TIMEOUT_MS = '45000';
    const timeout = (connector as unknown as { getTimeout: () => number }).getTimeout();
    expect(timeout).toBe(45_000);
  });

  it('defaults timeout to 30000', () => {
    const timeout = (connector as unknown as { getTimeout: () => number }).getTimeout();
    expect(timeout).toBe(30_000);
  });

  describe('buildRequestBody', () => {
    it('includes user message', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello world',
        model: 'deepseek-v4-flash',
      }) as { messages: Array<{ role: string; content: string }>; model: string };
      expect(body.messages).toContainEqual({ role: 'user', content: 'Hello world' });
      expect(body.model).toBe('deepseek-v4-flash');
    });

    it('includes system prompt when provided', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
        systemPrompt: 'You are helpful',
      }) as { messages: Array<{ role: string; content: string }> };
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
    });

    it('uses default model when none provided', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
      }) as { model: string };
      expect(body.model).toBe('deepseek-v4-flash');
    });

    it('sets response_format for json_object', () => {
      const body = (
        connector as unknown as { buildRequestBody: (r: unknown) => unknown }
      ).buildRequestBody({
        prompt: 'Hello',
        responseFormat: { type: 'json_object' },
      }) as { response_format?: { type: string } };
      expect(body.response_format).toEqual({ type: 'json_object' });
    });
  });

  describe('parseResponse', () => {
    it('parses successful response', () => {
      const json = {
        id: 'id-1',
        model: 'deepseek-v4-flash',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(json, { prompt: 'hi', model: 'deepseek-v4-flash' }) as {
        text: string;
        costUsd: number;
        isError: boolean;
        inputTokens: number;
        outputTokens: number;
      };
      expect(result.text).toBe('Hello!');
      expect(result.costUsd).toBe(0); // Free tier always 0
      expect(result.isError).toBe(false);
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
    });

    it('returns error when no choices', () => {
      const json = { id: 'id-1', model: 'deepseek-v4-flash', choices: [] };
      const result = (
        connector as unknown as { parseResponse: (j: unknown, r: unknown) => unknown }
      ).parseResponse(json, { prompt: 'hi' }) as { isError: boolean; errorMessage: string };
      expect(result.isError).toBe(true);
      expect(result.errorMessage).toMatch(/No choices/);
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

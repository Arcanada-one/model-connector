import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaCloudConnector } from './ollama-cloud.connector';

describe('OllamaCloudConnector', () => {
  let connector: OllamaCloudConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.OLLAMA_CLOUD_API_KEY = 'ollama-test-key';
    connector = new OllamaCloudConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OLLAMA_CLOUD_API_KEY;
  });

  function ok(body: unknown): void {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  }

  it('sends non-streaming chat only to the hosted API with bearer auth', async () => {
    ok({
      model: 'gpt-oss:120b',
      message: { role: 'assistant', content: 'pong' },
      done: true,
      prompt_eval_count: 5,
      eval_count: 1,
    });

    const response = await connector.execute({
      prompt: 'ping',
      systemPrompt: 'Be concise',
      model: 'gpt-oss:120b',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://ollama.com/api/chat');
    expect(fetchSpy.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer ollama-test-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string)).toEqual({
      model: 'gpt-oss:120b',
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'ping' },
      ],
      stream: false,
    });
    expect(response.result).toBe('pong');
    expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 1, costUsd: 0 });
  });

  it('uses the documented hosted generate operation when explicitly selected', async () => {
    ok({
      model: 'gpt-oss:120b',
      response: 'generated',
      done: true,
      prompt_eval_count: 4,
      eval_count: 2,
    });

    const response = await connector.execute({
      prompt: 'write',
      model: 'gpt-oss:120b',
      systemPrompt: 'Be concise',
      responseFormat: { type: 'json_object' },
      extra: { operation: 'generate', temperature: 0.2 },
    });

    expect(fetchSpy.mock.calls[0][0]).toBe('https://ollama.com/api/generate');
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string)).toEqual({
      model: 'gpt-oss:120b',
      prompt: 'write',
      system: 'Be concise',
      format: 'json',
      options: { temperature: 0.2 },
      stream: false,
    });
    expect(response.result).toBe('generated');
  });

  it('rejects undocumented operations before any hosted request', async () => {
    const response = await connector.execute({ prompt: 'x', extra: { operation: 'pull' } });
    expect(response.status).toBe('error');
    expect(response.error?.message).toContain('Unsupported Ollama Cloud operation: pull');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('discovers hosted models from tags with bearer auth and replace semantics', async () => {
    ok({
      models: [
        { name: 'gpt-oss:120b', model: 'gpt-oss:120b' },
        { name: 'qwen3-coder:480b', model: 'qwen3-coder:480b' },
      ],
    });

    await connector.refreshModels();

    expect(fetchSpy.mock.calls[0][0]).toBe('https://ollama.com/api/tags');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer ollama-test-key');
    expect(connector.getCapabilities().models).toEqual([
      'gpt-oss:120b',
      'qwen3-coder:480b',
    ]);
  });

  it('keeps an honest empty model fallback and Cloud-only capabilities', async () => {
    expect(connector.getCapabilities()).toMatchObject({
      name: 'ollama-cloud',
      type: 'api',
      models: [],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      modality: 'chat',
    });

    ok({ models: [{ name: ':cloud' }, {}, { model: '' }] });
    await connector.refreshModels();
    expect(connector.getCapabilities().models).toEqual([]);
  });
});

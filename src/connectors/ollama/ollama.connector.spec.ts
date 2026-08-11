import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaConnector } from './ollama.connector';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('OllamaConnector', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OLLAMA_BASE_URL;
  });

  it('uses the loopback API without an authorization header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          model: 'qwen3:8b',
          message: { content: 'local' },
          done: true,
          prompt_eval_count: 4,
          eval_count: 2,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const response = await new OllamaConnector().execute({ prompt: 'hello', model: 'qwen3:8b' });
    expect(response.status).toBe('success');
    expect(response.result).toBe('local');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3:8b',
          messages: [{ role: 'user', content: 'hello' }],
          stream: false,
        }),
      }),
    );
  });

  it('rejects Ollama Cloud before making a request', () => {
    process.env.OLLAMA_BASE_URL = 'https://ollama.com/api';
    expect(() => new OllamaConnector().getCapabilities()).toThrow(/Ollama Cloud/);
  });

  it('discovers installed local models from tags', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({
            models: [{ name: 'llama3.2:latest' }, { model: 'nomic-embed-text:latest' }],
          }),
        ),
    );
    const connector = new OllamaConnector();
    await connector.refreshModels();
    expect(connector.getCapabilities().models).toEqual([
      'llama3.2:latest',
      'nomic-embed-text:latest',
    ]);
  });

  it('uses native lifecycle endpoints and deterministic non-streaming pull', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ details: { family: 'qwen3' } }))
      .mockResolvedValueOnce(jsonResponse({ status: 'success' }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(jsonResponse({ version: '0.9.0' }));
    vi.stubGlobal('fetch', fetchMock);
    const connector = new OllamaConnector();
    await connector.showModel('qwen3:8b');
    await connector.pullModel('qwen3:8b');
    await connector.deleteModel('qwen3:8b');
    await connector.listRunningModels();
    await connector.getVersion();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://127.0.0.1:11434/api/show', 'POST', JSON.stringify({ model: 'qwen3:8b' })],
      [
        'http://127.0.0.1:11434/api/pull',
        'POST',
        JSON.stringify({ model: 'qwen3:8b', stream: false }),
      ],
      ['http://127.0.0.1:11434/api/delete', 'DELETE', JSON.stringify({ model: 'qwen3:8b' })],
      ['http://127.0.0.1:11434/api/ps', 'GET', undefined],
      ['http://127.0.0.1:11434/api/version', 'GET', undefined],
    ]);
  });
});

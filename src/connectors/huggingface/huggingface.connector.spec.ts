import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HuggingFaceConnector } from './huggingface.connector';

describe('HuggingFaceConnector (CONN-0253)', () => {
  const fetchMock = vi.fn();
  let connector: HuggingFaceConnector;

  beforeEach(() => {
    process.env.HF_TOKEN = 'hf_test_token';
    vi.stubGlobal('fetch', fetchMock);
    connector = new HuggingFaceConnector();
  });

  afterEach(() => {
    delete process.env.HF_TOKEN;
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('uses the HF router, Bearer auth, and preserves an exact-provider suffix', async () => {
    fetchMock.mockResolvedValue(
      response({
        id: 'chat-1',
        model: 'openai/gpt-oss-120b:cerebras',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );

    const result = await connector.execute({
      prompt: 'hello',
      systemPrompt: 'be concise',
      model: 'openai/gpt-oss-120b:cerebras',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://router.huggingface.co/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer hf_test_token' });
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'openai/gpt-oss-120b:cerebras',
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(result.result).toBe('ok');
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });

  it('preserves documented policy suffixes and allowlisted chat parameters', async () => {
    fetchMock.mockResolvedValue(
      response({
        id: 'chat-2',
        model: 'Qwen/Qwen3-32B:cheapest',
        choices: [{ message: { role: 'assistant', content: 'json' }, finish_reason: 'stop' }],
      }),
    );
    await connector.execute({
      prompt: 'hello',
      model: 'Qwen/Qwen3-32B:cheapest',
      responseFormat: { type: 'json_object' },
      extra: { temperature: 0.2, max_tokens: 40, top_p: 0.9, undocumented: 'drop' },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      model: 'Qwen/Qwen3-32B:cheapest',
      temperature: 0.2,
      max_tokens: 40,
      top_p: 0.9,
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('undocumented');
  });

  it('returns an error for an empty choices array', async () => {
    fetchMock.mockResolvedValue(response({ id: 'bad', model: 'x', choices: [] }));
    const result = await connector.execute({ prompt: 'hello', model: 'x' });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('No choices');
  });

  it.each([
    [401, 'auth_error'],
    [403, 'auth_error'],
    [429, 'rate_limited'],
    [500, 'server_error'],
  ])('classifies HTTP %i as %s', async (status, type) => {
    fetchMock.mockResolvedValue(
      response({ error: { message: 'provider variable error' } }, status),
    );
    const result = await connector.execute({ prompt: 'hello', model: 'x' });
    expect(result.error?.type).toBe(type);
  });

  it('advertises only implemented behavior and performs no boot model refresh', () => {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(connector.getCapabilities()).toMatchObject({
      name: 'huggingface',
      type: 'api',
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      modality: 'chat',
    });
  });
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

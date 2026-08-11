import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MistralConnector } from './mistral.connector';

const modelsFixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../..', 'test/fixtures/connectors/mistral-models.json'),
    'utf8',
  ),
);

const chatResponse = {
  id: 'cmpl-fixture',
  object: 'chat.completion',
  created: 1750000000,
  model: 'mistral-small-2506',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Bonjour' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
};

describe('MistralConnector', () => {
  let connector: MistralConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.MISTRAL_API_KEY = 'mistral_fixture_key';
    connector = new MistralConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MISTRAL_API_KEY;
  });

  const ok = (body: unknown) =>
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });

  it('uses native identity, URL, Bearer auth and Mistral-compatible body', async () => {
    ok(chatResponse);
    await connector.execute({
      prompt: 'hello',
      systemPrompt: 'Be concise',
      model: 'mistral-small-latest',
      responseFormat: { type: 'json_object' },
      extra: { max_tokens: 20, temperature: 0.2, top_p: 0.8 },
    });
    expect(connector.name).toBe('mistral');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.mistral.ai/v1/chat/completions');
    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers.Authorization).toBe('Bearer mistral_fixture_key');
    expect(JSON.parse(init.body)).toEqual({
      model: 'mistral-small-latest',
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'hello' },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 20,
      temperature: 0.2,
      top_p: 0.8,
    });
  });

  it('maps text, resolved model and usage', async () => {
    ok(chatResponse);
    const response = await connector.execute({ prompt: 'hello' });
    expect(response).toMatchObject({
      connector: 'mistral',
      model: 'mistral-small-2506',
      result: 'Bonjour',
      status: 'success',
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9, costUsd: 0 },
    });
  });

  it('returns a controlled error for no choices', async () => {
    ok({ ...chatResponse, choices: [] });
    expect(await connector.execute({ prompt: 'hello' })).toMatchObject({
      status: 'error',
      error: { type: 'api_error' },
    });
  });

  it.each([
    [401, 'auth_error'],
    [402, 'http_error'],
    [429, 'rate_limited'],
    [500, 'server_error'],
  ] as const)('classifies HTTP %s as %s', async (status, type) => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status,
      text: async () => JSON.stringify({ message: 'fixture failure' }),
    });
    const response = await connector.execute({ prompt: 'hello' });
    expect(response.error?.type).toBe(type);
    expect(response.error?.message).not.toContain('mistral_fixture_key');
  });

  it('refreshes the native model list with metadata and filters non-chat/archived cards', async () => {
    ok(modelsFixture);
    await connector.refreshModels();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.mistral.ai/v1/models');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer mistral_fixture_key');
    const caps = connector.getCapabilities();
    expect(caps.models).toEqual(['mistral-large-latest', 'mistral-small-latest']);
    expect(caps.modelMeta).toContainEqual(
      expect.objectContaining({
        id: 'mistral-large-latest',
        modality: 'chat',
        contextWindow: 131072,
      }),
    );
    expect(caps.models).not.toContain('retired-model');
    expect(caps.models).not.toContain('mistral-embed');
  });

  it('keeps a static offline fallback and reports executable capabilities truthfully', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('offline fixture'));
    await connector.refreshModels();
    expect(connector.getCapabilities()).toMatchObject({
      name: 'mistral',
      type: 'api',
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      freeModels: [],
    });
    expect(connector.getCapabilities().models).toContain('mistral-small-latest');
  });
});

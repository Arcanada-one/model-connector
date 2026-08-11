import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FireworksConnector } from './fireworks.connector';
import { FireworksModule } from './fireworks.module';

const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../..', 'test/fixtures/connectors/fireworks-chat-completion.json'),
    'utf8',
  ),
);

describe('FireworksConnector', () => {
  let connector: FireworksConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.FIREWORKS_API_KEY = 'fw_test_key';
    connector = new FireworksConnector();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fixture });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FIREWORKS_API_KEY;
  });

  it('uses the official inference chat URL and Bearer authentication', async () => {
    await connector.execute({ prompt: 'hello' });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.fireworks.ai/inference/v1/chat/completions',
    );
    expect(fetchSpy.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer fw_test_key',
    });
  });

  it('preserves account-qualified model names and maps documented usage', async () => {
    const response = await connector.execute({
      prompt: 'hello',
      model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      extra: { max_tokens: 64, temperature: 0.2, top_p: 0.9 },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.model).toBe('accounts/fireworks/models/llama-v3p1-8b-instruct');
    expect(body).toMatchObject({ max_tokens: 64, temperature: 0.2, top_p: 0.9 });
    expect(response.result).toBe('ok');
    expect(response.usage).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10, costUsd: 0 });
  });

  it('builds system and user messages and uses the account-qualified default model', async () => {
    await connector.execute({ prompt: 'hello', systemPrompt: 'Be concise' });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'hello' },
      ],
    });
  });

  it('returns a safe error result when Fireworks sends no choices', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...fixture, choices: [] }),
    });
    expect(await connector.execute({ prompt: 'hello' })).toMatchObject({
      status: 'error',
      result: '',
    });
  });

  it('advertises a distinct and conservative capability surface', () => {
    expect(connector.getCapabilities()).toMatchObject({
      name: 'fireworks',
      type: 'api',
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
    });
  });

  it('uses the base error taxonomy for Fireworks authentication and rate limits', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
    expect((await connector.execute({ prompt: 'hello' })).error?.type).toBe('auth_error');
    connector = new FireworksConnector();
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'Capacity' });
    expect((await connector.execute({ prompt: 'hello' })).error?.type).toBe('rate_limited');
  });

  it.each([
    [403, 'auth_error'],
    [503, 'server_error'],
  ])('classifies HTTP %i without exposing the request credential', async (status, type) => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status,
      text: async () => `Fireworks error ${status}`,
    });
    const response = await connector.execute({ prompt: 'hello' });
    expect(response.error?.type).toBe(type);
    expect(response.error?.message).not.toContain('fw_test_key');
  });

  it('registers with Nest without invoking model refresh at boot', () => {
    const register = vi.fn();
    const refreshModels = vi.spyOn(connector, 'refreshModels');
    new FireworksModule(connector, { register } as never);
    expect(register).toHaveBeenCalledWith(connector);
    expect(refreshModels).not.toHaveBeenCalled();
  });
});

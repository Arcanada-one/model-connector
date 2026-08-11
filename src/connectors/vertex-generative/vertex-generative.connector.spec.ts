import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VertexGenerativeConnector } from './vertex-generative.connector';

const config = {
  project: 'project/a',
  location: 'us central1',
  models: ['gemini-2.5-flash', 'model/a'],
};

describe('VertexGenerativeConnector', () => {
  const tokenProvider = vi.fn<() => Promise<string>>();
  const fetchMock = vi.fn();

  beforeEach(() => {
    tokenProvider.mockReset().mockResolvedValue('synthetic-token');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  function connector() {
    return new VertexGenerativeConnector(config, tokenProvider);
  }

  function ok(body: unknown) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  }

  it('uses the exact encoded regional google publisher unary endpoint', async () => {
    ok({ candidates: [] });
    await connector().execute({ prompt: 'hello', model: 'model/a' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://us%20central1-aiplatform.googleapis.com/v1/projects/project%2Fa/locations/us%20central1/publishers/google/models/model%2Fa:generateContent',
    );
  });

  it('calls the async token provider per request and sends its bearer token', async () => {
    ok({ candidates: [] });
    ok({ candidates: [] });
    const subject = connector();
    await subject.execute({ prompt: 'one' });
    await subject.execute({ prompt: 'two' });

    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer synthetic-token',
    });
  });

  it.each(['', '   '])('fails closed on empty token %j before fetch', async (token) => {
    tokenProvider.mockResolvedValueOnce(token);
    const response = await connector().execute({ prompt: 'hello' });
    expect(response.status).toBe('error');
    expect(response.error?.message).toMatch(/token provider returned an empty token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on provider rejection before fetch without leaking token material', async () => {
    tokenProvider.mockRejectedValueOnce(new Error('token unavailable'));
    const response = await connector().execute({ prompt: 'hello' });
    expect(response.status).toBe('error');
    expect(response.error?.message).toContain('token unavailable');
    expect(response.error?.message).not.toContain('synthetic-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps prompt, system instruction, generation config and JSON schema', async () => {
    ok({ candidates: [] });
    const schema = { type: 'object', properties: { answer: { type: 'string' } } };
    await connector().execute({
      prompt: 'Question',
      systemPrompt: 'Be precise',
      jsonSchema: schema,
      extra: {
        generationConfig: {
          temperature: 0.2,
          topP: 0.9,
          topK: 20,
          maxOutputTokens: 300,
          stopSequences: ['STOP'],
        },
      },
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Question' }] }],
      systemInstruction: { role: 'system', parts: [{ text: 'Be precise' }] },
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        topK: 20,
        maxOutputTokens: 300,
        stopSequences: ['STOP'],
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    });
  });

  it('maps all candidates, prompt feedback and usage while deriving ordered text', async () => {
    ok({
      candidates: [
        { index: 0, content: { parts: [{ text: 'Hello ' }, { functionCall: { name: 'x' } }] } },
        { index: 1, content: { parts: [{ text: 'world' }] }, finishReason: 'FUTURE_REASON' },
      ],
      promptFeedback: { blockReason: 'OTHER' },
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
      modelVersion: 'gemini-version',
      responseId: 'response-1',
    });
    const response = await connector().execute({ prompt: 'hello' });

    expect(response.status).toBe('success');
    expect(response.result).toBe('Hello world');
    expect(response.usage).toMatchObject({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(response.structured).toMatchObject({
      candidates: expect.any(Array),
      promptFeedback: { blockReason: 'OTHER' },
      modelVersion: 'gemini-version',
      responseId: 'response-1',
    });
  });

  it('treats prompt-feedback-only responses as successful', async () => {
    ok({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { totalTokenCount: 2 } });
    const response = await connector().execute({ prompt: 'hello' });
    expect(response.status).toBe('success');
    expect(response.result).toBe('');
    expect(response.structured).toMatchObject({ promptFeedback: { blockReason: 'SAFETY' } });
  });

  it.each([
    [400, 'validation_error'],
    [403, 'auth_error'],
    [429, 'rate_limited'],
    [503, 'server_error'],
  ])('maps Google error envelope HTTP %i to %s', async (status, type) => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status,
      text: async () =>
        JSON.stringify({
          error: {
            code: status,
            message: 'provider rejected request',
            status: 'GOOGLE_STATUS',
            details: [],
          },
        }),
    });
    const response = await connector().execute({ prompt: 'hello' });
    expect(response.error?.type).toBe(type);
    expect(response.error?.message).toContain('GOOGLE_STATUS');
    expect(response.error?.message).not.toContain('synthetic-token');
  });

  it('maps a non-JSON upstream error safely', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'upstream failed',
    });
    const response = await connector().execute({ prompt: 'hello' });
    expect(response.error).toMatchObject({ type: 'server_error', message: 'upstream failed' });
  });

  it('exposes deterministic configured models and no streaming', () => {
    expect(connector().getCapabilities()).toMatchObject({
      name: 'vertex-generative',
      models: ['gemini-2.5-flash', 'model/a'],
      supportsStreaming: false,
      supportsJsonSchema: true,
    });
  });

  it('rejects an unconfigured model before token acquisition and fetch', async () => {
    const response = await connector().execute({ prompt: 'hello', model: 'unknown' });
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('validation_error');
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  BedrockConnector,
  type BedrockSigner,
  type BedrockSignedRequest,
} from './bedrock.connector';

const model = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/model/path%v1';

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      output: { message: { role: 'assistant', content: [{ text: 'Hello' }, { text: ' world' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function setup(response: Response = successResponse()) {
  const signer = vi.fn<BedrockSigner>(async (request) => ({
    ...request,
    url: `${request.url}?signed=true`,
    headers: { ...request.headers, Authorization: 'AWS4-HMAC-SHA256 test' },
  }));
  const fetchFn = vi.fn(async () => response);
  const connector = new BedrockConnector(
    { BEDROCK_REGION: 'us-east-1', BEDROCK_MODELS: [model, 'model-b'] },
    signer,
    fetchFn,
  );
  return { connector, signer, fetchFn };
}

describe('BedrockConnector', () => {
  it('exposes deterministic non-streaming capabilities', () => {
    const { connector } = setup();
    expect(connector.getCapabilities()).toMatchObject({
      name: 'bedrock',
      type: 'api',
      models: [model, 'model-b'],
      supportsStreaming: false,
    });
  });

  it('signs the complete Converse request and fetches signer-returned fields', async () => {
    const { connector, signer, fetchFn } = setup();
    const response = await connector.execute({
      model,
      prompt: 'Hi',
      systemPrompt: 'Be concise',
      extra: { max_tokens: 123, temperature: 0.2, top_p: 0.9, stop: ['DONE'] },
    });

    const unsigned = signer.mock.calls[0][0];
    expect(unsigned.method).toBe('POST');
    expect(unsigned.url).toBe(
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
    );
    expect(unsigned.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(unsigned.body)).toEqual({
      messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
      system: [{ text: 'Be concise' }],
      inferenceConfig: { maxTokens: 123, temperature: 0.2, topP: 0.9, stopSequences: ['DONE'] },
    });
    const signed = (await signer.mock.results[0].value) as BedrockSignedRequest;
    expect(fetchFn).toHaveBeenCalledWith(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: signed.body,
    });
    expect(response).toMatchObject({
      connector: 'bedrock',
      model,
      result: 'Hello world',
      status: 'success',
      structured: { stopReason: 'end_turn' },
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: 0 },
    });
  });

  it('rejects unknown models before signer or fetch', async () => {
    const { connector, signer, fetchFn } = setup();
    const response = await connector.execute({ model: 'unknown', prompt: 'Hi' });
    expect(response.error?.type).toBe('model_not_found');
    expect(signer).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects multimodal input without I/O', async () => {
    const { connector, signer, fetchFn } = setup();
    const response = await connector.execute({
      model,
      prompt: [{ type: 'image_url', image_url: { url: 'https://example.test/x.png' } }],
    });
    expect(response.error?.type).toBe('unsupported_modality');
    expect(signer).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('maps malformed success JSON to parse_error', async () => {
    const { connector } = setup(new Response('{', { status: 200 }));
    const response = await connector.execute({ model, prompt: 'Hi' });
    expect(response.error?.type).toBe('parse_error');
  });

  it.each([
    [400, 'ValidationException', 'validation_error'],
    [403, 'AccessDeniedException', 'auth_error'],
    [404, 'ResourceNotFoundException', 'model_not_found'],
    [429, 'ThrottlingException', 'rate_limited'],
    [408, 'ModelTimeoutException', 'timeout'],
    [500, 'InternalServerException', 'server_error'],
    [503, 'ServiceUnavailableException', 'server_error'],
    [503, 'ModelNotReadyException', 'server_error'],
  ])('maps AWS %s %s to %s', async (status, type, expected) => {
    const { connector } = setup(
      new Response(JSON.stringify({ __type: `aws#${type}`, message: 'safe message' }), { status }),
    );
    const response = await connector.execute({ model, prompt: 'Hi' });
    expect(response.error).toMatchObject({ type: expected, message: 'safe message' });
    expect(response.error?.message.length).toBeLessThanOrEqual(500);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  IBM_WATSONX_AI_API_VERSION,
  IBM_WATSONX_AI_BASE_URLS,
  IBM_WATSONX_AI_LIMITS,
  IbmWatsonxAiError,
  createIbmWatsonxAiConnector,
} from './ibm-watsonx-ai.connector';
import {
  SYNTHETIC_IMAGE_BYTES,
  SYNTHETIC_IMAGE_MODEL_ID,
  SYNTHETIC_MODEL_ID,
  SYNTHETIC_PROJECT_ID,
  SYNTHETIC_PROVIDER_ERROR,
  SYNTHETIC_SPACE_ID,
  SYNTHETIC_TEXT_RESPONSE,
} from './synthetic-fixtures';

const DALLAS = 'https://us-south.ml.cloud.ibm.com';

function jsonResponse(body: unknown = structuredClone(SYNTHETIC_TEXT_RESPONSE), status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body,
  };
}

function imageResponse(body: unknown = new Uint8Array(SYNTHETIC_IMAGE_BYTES), status = 200) {
  return {
    status,
    headers: { 'content-type': 'image/png' },
    body,
  };
}

function setup(response: unknown = jsonResponse(), overrides: Record<string, unknown> = {}) {
  const transport = vi.fn(async () => response);
  const connector = createIbmWatsonxAiConnector({
    baseUrl: DALLAS,
    apiVersion: '2024-03-14',
    bearerToken: 'synthetic-bearer-token',
    timeoutMs: 1_000,
    transport,
    ...overrides,
  });
  return { connector, transport };
}

function textProjectRequest(overrides: Record<string, unknown> = {}) {
  return {
    modelId: SYNTHETIC_MODEL_ID,
    input: 'synthetic prompt',
    scope: { projectId: SYNTHETIC_PROJECT_ID },
    ...overrides,
  };
}

function imageSpaceRequest(overrides: Record<string, unknown> = {}) {
  return {
    modelId: SYNTHETIC_IMAGE_MODEL_ID,
    input: 'synthetic image prompt',
    scope: { spaceId: SYNTHETIC_SPACE_ID },
    ...overrides,
  };
}

async function expectLocalError(
  action: () => Promise<unknown> | unknown,
  code: string,
  forbidden: string[] = [],
) {
  try {
    await action();
    throw new Error('expected local connector error');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(IbmWatsonxAiError);
    const local = error as IbmWatsonxAiError;
    expect(local.code).toBe(code);
    expect(Object.hasOwn(local, 'cause')).toBe(false);
    const serialized = JSON.stringify({ message: local.message, code: local.code, status: local.status });
    for (const value of forbidden) expect(serialized).not.toContain(value);
    return local;
  }
}

describe('IBM watsonx.ai frozen identity', () => {
  it('freezes the exact active API version', () => {
    expect(IBM_WATSONX_AI_API_VERSION).toBe('2024-03-14');
  });

  it('freezes only the seven first-party service bases', () => {
    expect(IBM_WATSONX_AI_BASE_URLS).toEqual([
      'https://us-south.ml.cloud.ibm.com',
      'https://eu-de.ml.cloud.ibm.com',
      'https://eu-gb.ml.cloud.ibm.com',
      'https://jp-tok.ml.cloud.ibm.com',
      'https://au-syd.ml.cloud.ibm.com',
      'https://ca-tor.ml.cloud.ibm.com',
      'https://ap-south-1.aws.wxai.ibm.com',
    ]);
    expect(Object.isFrozen(IBM_WATSONX_AI_BASE_URLS)).toBe(true);
  });

  it('publishes the frozen local limits', () => {
    expect(IBM_WATSONX_AI_LIMITS).toEqual({
      modelIdBytes: 256,
      inputBytes: 32_768,
      bearerTokenBytes: 8_192,
      timeoutMs: 120_000,
      jsonDepth: 8,
      recordKeys: 16,
      arrayItems: 16,
      visitedNodes: 128,
      responseStringBytes: 65_536,
      imageBytes: 10 * 1024 * 1024,
      textResults: 8,
    });
  });
});

describe('configuration boundary', () => {
  it.each(IBM_WATSONX_AI_BASE_URLS)('accepts documented base %s', async (baseUrl) => {
    const { connector, transport } = setup(jsonResponse(), { baseUrl });
    await connector.generateText(textProjectRequest());
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    'https://example.com',
    'http://us-south.ml.cloud.ibm.com',
    'https://us-south.ml.cloud.ibm.com/',
    'https://us-south.ml.cloud.ibm.com/path',
    'https://user@us-south.ml.cloud.ibm.com',
    'https://us-south.ml.cloud.ibm.com?x=1',
    'https://us-south.ml.cloud.ibm.com#x',
  ])('rejects arbitrary or decorated base %s', async (baseUrl) => {
    await expectLocalError(() => setup(jsonResponse(), { baseUrl }), 'invalid_configuration');
  });

  it('rejects a wrong or missing version without a transport call', async () => {
    await expectLocalError(
      () => setup(jsonResponse(), { apiVersion: '2025-01-01' }),
      'invalid_configuration',
    );
    await expectLocalError(
      () => setup(jsonResponse(), { apiVersion: undefined }),
      'invalid_configuration',
    );
  });

  it('rejects extra configuration keys', async () => {
    await expectLocalError(() => setup(jsonResponse(), { retry: 1 }), 'invalid_configuration');
  });

  it('rejects empty and oversized bearer tokens without leaking them', async () => {
    await expectLocalError(
      () => setup(jsonResponse(), { bearerToken: '' }),
      'invalid_configuration',
    );
    const secret = 's'.repeat(8_193);
    await expectLocalError(
      () => setup(jsonResponse(), { bearerToken: secret }),
      'invalid_configuration',
      [secret],
    );
  });

  it.each([0, 120_001, 1.5, Number.NaN])('rejects timeout %s', async (timeoutMs) => {
    await expectLocalError(() => setup(jsonResponse(), { timeoutMs }), 'invalid_configuration');
  });

  it('rejects accessors before invoking them', async () => {
    let accessed = false;
    const config = {
      baseUrl: DALLAS,
      apiVersion: '2024-03-14',
      bearerToken: 'synthetic-bearer-token',
      timeoutMs: 1_000,
      transport: vi.fn(),
    };
    Object.defineProperty(config, 'baseUrl', {
      enumerable: true,
      get() {
        accessed = true;
        return DALLAS;
      },
    });
    await expectLocalError(
      () => createIbmWatsonxAiConnector(config),
      'invalid_configuration',
    );
    expect(accessed).toBe(false);
  });
});

describe('foundation inference request and response', () => {
  it('emits exact project-scoped method, URL, headers, and JSON body', async () => {
    const { connector, transport } = setup();
    const result = await connector.generateText(textProjectRequest());
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[0]).toEqual({
      method: 'POST',
      url: `${DALLAS}/ml/v1/text/generation?version=2024-03-14`,
      headers: {
        Authorization: 'Bearer synthetic-bearer-token',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: {
        model_id: SYNTHETIC_MODEL_ID,
        input: 'synthetic prompt',
        project_id: SYNTHETIC_PROJECT_ID,
      },
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({
      modelId: SYNTHETIC_MODEL_ID,
      createdAt: '2026-01-01T00:00:00.000Z',
      results: [
        {
          generatedText: 'synthetic completion',
          stopReason: 'eos_token',
          generatedTokenCount: 2,
          inputTokenCount: 3,
        },
      ],
    });
  });

  it('emits space_id instead of project_id', async () => {
    const { connector, transport } = setup();
    await connector.generateText(
      textProjectRequest({ scope: { spaceId: SYNTHETIC_SPACE_ID } }),
    );
    expect(transport.mock.calls[0]?.[0].body).toEqual({
      model_id: SYNTHETIC_MODEL_ID,
      input: 'synthetic prompt',
      space_id: SYNTHETIC_SPACE_ID,
    });
  });

  it('accepts application/json with a valid charset parameter', async () => {
    const response = jsonResponse();
    response.headers['content-type'] = 'application/json; charset=utf-8';
    const { connector } = setup(response);
    await expect(connector.generateText(textProjectRequest())).resolves.toBeDefined();
  });

  it('rejects image content and binary output on the text operation', async () => {
    const { connector } = setup(imageResponse());
    await expectLocalError(
      () => connector.generateText(textProjectRequest()),
      'invalid_response',
    );
  });

  it('rejects missing, extra, and malformed text response fields', async () => {
    const bodies = [
      { created_at: '2026-01-01T00:00:00Z', results: [] },
      { ...SYNTHETIC_TEXT_RESPONSE, extra: true },
      { ...SYNTHETIC_TEXT_RESPONSE, results: [] },
      { ...SYNTHETIC_TEXT_RESPONSE, results: [{ generated_text: 'x' }] },
      {
        ...SYNTHETIC_TEXT_RESPONSE,
        results: [{ generated_text: 'x', stop_reason: 'invented_reason' }],
      },
      {
        ...SYNTHETIC_TEXT_RESPONSE,
        results: [{ generated_text: 'x', stop_reason: 'eos_token', extra: true }],
      },
      {
        ...SYNTHETIC_TEXT_RESPONSE,
        results: [{ generated_text: 'x', stop_reason: 'eos_token', input_token_count: -1 }],
      },
    ];
    for (const body of bodies) {
      const { connector } = setup(jsonResponse(body));
      await expectLocalError(
        () => connector.generateText(textProjectRequest()),
        'invalid_response',
      );
    }
  });

  it('accepts every documented stop reason without conversion', async () => {
    const reasons = [
      'not_finished',
      'max_tokens',
      'eos_token',
      'cancelled',
      'time_limit',
      'stop_sequence',
      'token_limit',
      'error',
    ];
    for (const stop_reason of reasons) {
      const body = structuredClone(SYNTHETIC_TEXT_RESPONSE);
      body.results[0].stop_reason = stop_reason;
      const { connector } = setup(jsonResponse(body));
      const result = await connector.generateText(textProjectRequest());
      expect(result.results[0]?.stopReason).toBe(stop_reason);
    }
  });

  it('enforces the result-count and response-string limits', async () => {
    const tooMany = structuredClone(SYNTHETIC_TEXT_RESPONSE);
    tooMany.results = Array.from({ length: 9 }, () => ({
      generated_text: 'x',
      stop_reason: 'eos_token',
      generated_token_count: 1,
      input_token_count: 1,
    }));
    const oversized = structuredClone(SYNTHETIC_TEXT_RESPONSE);
    oversized.results[0].generated_text = 'x'.repeat(65_537);
    for (const body of [tooMany, oversized]) {
      const { connector } = setup(jsonResponse(body));
      await expectLocalError(
        () => connector.generateText(textProjectRequest()),
        'invalid_response',
      );
    }
  });

  it('copies and freezes all structured output', async () => {
    const body = structuredClone(SYNTHETIC_TEXT_RESPONSE);
    const { connector } = setup(jsonResponse(body));
    const result = await connector.generateText(textProjectRequest());
    body.results[0].generated_text = 'mutated provider storage';
    expect(result.results[0]?.generatedText).toBe('synthetic completion');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.results)).toBe(true);
    expect(Object.isFrozen(result.results[0])).toBe(true);
  });
});

describe('native image request and response', () => {
  it('emits the distinct path, PNG accept header, and space scope', async () => {
    const { connector, transport } = setup(imageResponse());
    const result = await connector.generateImage(imageSpaceRequest());
    expect(transport.mock.calls[0]?.[0]).toEqual({
      method: 'POST',
      url: `${DALLAS}/ml/v1/text/image?version=2024-03-14`,
      headers: {
        Authorization: 'Bearer synthetic-bearer-token',
        Accept: 'image/png',
        'Content-Type': 'application/json',
      },
      body: {
        model_id: SYNTHETIC_IMAGE_MODEL_ID,
        input: 'synthetic image prompt',
        space_id: SYNTHETIC_SPACE_ID,
      },
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual(SYNTHETIC_IMAGE_BYTES);
  });

  it('emits project scope without deployment or gateway fields', async () => {
    const { connector, transport } = setup(imageResponse());
    await connector.generateImage(
      imageSpaceRequest({ scope: { projectId: SYNTHETIC_PROJECT_ID } }),
    );
    expect(transport.mock.calls[0]?.[0].body).toEqual({
      model_id: SYNTHETIC_IMAGE_MODEL_ID,
      input: 'synthetic image prompt',
      project_id: SYNTHETIC_PROJECT_ID,
    });
  });

  it('accepts a syntactically valid PNG media-type parameter', async () => {
    const response = imageResponse();
    response.headers['content-type'] = 'image/png; synthetic=true';
    const { connector } = setup(response);
    await expect(connector.generateImage(imageSpaceRequest())).resolves.toBeDefined();
  });

  it('rejects JSON, empty, non-byte, and oversized image bodies', async () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    const responses = [
      jsonResponse(),
      imageResponse(new Uint8Array()),
      imageResponse('base64-is-not-png'),
      imageResponse(oversized),
    ];
    for (const response of responses) {
      const { connector } = setup(response);
      await expectLocalError(
        () => connector.generateImage(imageSpaceRequest()),
        'invalid_response',
      );
    }
  });

  it('copies image bytes without converting representation', async () => {
    const source = new Uint8Array(SYNTHETIC_IMAGE_BYTES);
    const { connector } = setup(imageResponse(source));
    const result = await connector.generateImage(imageSpaceRequest());
    source[0] = 0;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result[0]).toBe(0x89);
    expect(result).not.toBe(source);
  });
});

describe('request validation and hostile values', () => {
  it('rejects omitted and extra request keys before transport', async () => {
    for (const request of [
      { input: 'x', scope: { projectId: SYNTHETIC_PROJECT_ID } },
      { ...textProjectRequest(), extra: true },
      null,
      [],
    ]) {
      const { connector, transport } = setup();
      await expectLocalError(
        () => connector.generateText(request as never),
        'invalid_request',
      );
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('enforces model and input UTF-8 byte limits', async () => {
    const acceptedModel = 'm'.repeat(256);
    const acceptedInput = 'p'.repeat(32_768);
    const { connector, transport } = setup();
    await connector.generateText(
      textProjectRequest({ modelId: acceptedModel, input: acceptedInput }),
    );
    expect(transport).toHaveBeenCalledOnce();

    for (const request of [
      textProjectRequest({ modelId: '' }),
      textProjectRequest({ modelId: 'm'.repeat(257) }),
      textProjectRequest({ modelId: 'é'.repeat(129) }),
      textProjectRequest({ input: '' }),
      textProjectRequest({ input: 'p'.repeat(32_769) }),
    ]) {
      const current = setup();
      await expectLocalError(
        () => current.connector.generateText(request),
        'invalid_request',
      );
      expect(current.transport).not.toHaveBeenCalled();
    }
  });

  it('requires exactly one valid project or space scope', async () => {
    const scopes: unknown[] = [
      {},
      { projectId: SYNTHETIC_PROJECT_ID, spaceId: SYNTHETIC_SPACE_ID },
      { projectId: 'short' },
      { spaceId: 'x'.repeat(36) },
      { projectId: SYNTHETIC_PROJECT_ID, extra: true },
      { deploymentId: SYNTHETIC_PROJECT_ID },
    ];
    for (const scope of scopes) {
      const { connector, transport } = setup();
      await expectLocalError(
        () => connector.generateText(textProjectRequest({ scope })),
        'invalid_request',
      );
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it('accepts null-prototype data records and copies before transport', async () => {
    const scope = Object.create(null) as Record<string, unknown>;
    scope.projectId = SYNTHETIC_PROJECT_ID;
    const request = Object.create(null) as Record<string, unknown>;
    request.modelId = SYNTHETIC_MODEL_ID;
    request.input = 'synthetic prompt';
    request.scope = scope;
    const { connector, transport } = setup();
    const pending = connector.generateText(request as never);
    request.input = 'mutated caller input';
    await pending;
    expect(transport.mock.calls[0]?.[0].body.input).toBe('synthetic prompt');
  });

  it('rejects accessors without invoking them', async () => {
    let accessed = false;
    const request = textProjectRequest();
    Object.defineProperty(request, 'input', {
      enumerable: true,
      get() {
        accessed = true;
        return 'synthetic prompt';
      },
    });
    const { connector, transport } = setup();
    await expectLocalError(
      () => connector.generateText(request),
      'invalid_request',
    );
    expect(accessed).toBe(false);
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects cycles, symbols, class instances, dangerous keys, depth, and width', async () => {
    const cyclic: Record<string, unknown> = textProjectRequest();
    cyclic.self = cyclic;
    const symbolRecord = textProjectRequest();
    Object.defineProperty(symbolRecord, Symbol('hidden'), { value: true, enumerable: true });
    class RequestRecord {
      modelId = SYNTHETIC_MODEL_ID;
      input = 'synthetic prompt';
      scope = { projectId: SYNTHETIC_PROJECT_ID };
    }
    const dangerous = textProjectRequest();
    Object.defineProperty(dangerous, '__proto__', { value: {}, enumerable: true });
    let deep: Record<string, unknown> = {};
    const deepRoot = deep;
    for (let index = 0; index < 9; index += 1) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    const wide = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, index]));
    for (const request of [cyclic, symbolRecord, new RequestRecord(), dangerous, deepRoot, wide]) {
      const { connector, transport } = setup();
      await expectLocalError(
        () => connector.generateText(request as never),
        'invalid_request',
      );
      expect(transport).not.toHaveBeenCalled();
    }
  });
});

describe('transport boundary, errors, timeout, and redaction', () => {
  it('passes a deeply frozen request to the injected transport', async () => {
    const transport = vi.fn(async (request: unknown) => {
      const value = request as {
        headers: object;
        body: object;
      };
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(value.headers)).toBe(true);
      expect(Object.isFrozen(value.body)).toBe(true);
      return jsonResponse();
    });
    const connector = createIbmWatsonxAiConnector({
      baseUrl: DALLAS,
      apiVersion: '2024-03-14',
      bearerToken: 'synthetic-bearer-token',
      timeoutMs: 1_000,
      transport,
    });
    await connector.generateText(textProjectRequest());
  });

  it.each([400, 401, 403, 404])('maps documented status %s to one redacted provider error', async (status) => {
    const detail = 'synthetic provider detail must never escape';
    const trace = SYNTHETIC_PROVIDER_ERROR.trace;
    const { connector, transport } = setup(
      jsonResponse(structuredClone(SYNTHETIC_PROVIDER_ERROR), status),
    );
    const error = await expectLocalError(
      () => connector.generateText(textProjectRequest()),
      'provider_error',
      [detail, trace, 'synthetic-bearer-token', 'synthetic prompt'],
    );
    expect(error.status).toBe(status);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects malformed provider errors without leaking the malformed body', async () => {
    const raw = 'malformed-secret-provider-body';
    const { connector } = setup(jsonResponse({ trace: raw, errors: [] }, 400));
    await expectLocalError(
      () => connector.generateText(textProjectRequest()),
      'invalid_response',
      [raw],
    );
  });

  it('rejects extra transport response and header keys', async () => {
    const responses = [
      { ...jsonResponse(), extra: true },
      { ...jsonResponse(), headers: { 'content-type': 'application/json', server: 'secret' } },
    ];
    for (const response of responses) {
      const { connector } = setup(response);
      await expectLocalError(
        () => connector.generateText(textProjectRequest()),
        'invalid_response',
        ['secret'],
      );
    }
  });

  it('maps undocumented status to a fixed unexpected-response error', async () => {
    const { connector } = setup(jsonResponse({ secret: 'raw-body' }, 500));
    const error = await expectLocalError(
      () => connector.generateText(textProjectRequest()),
      'unexpected_response',
      ['raw-body'],
    );
    expect(error.status).toBe(500);
  });

  it('redacts thrown values and never retries', async () => {
    const transport = vi.fn(async () => {
      throw new Error('transport-secret synthetic-bearer-token synthetic prompt');
    });
    const connector = createIbmWatsonxAiConnector({
      baseUrl: DALLAS,
      apiVersion: '2024-03-14',
      bearerToken: 'synthetic-bearer-token',
      timeoutMs: 1_000,
      transport,
    });
    await expectLocalError(
      () => connector.generateText(textProjectRequest()),
      'transport_error',
      ['transport-secret', 'synthetic-bearer-token', 'synthetic prompt'],
    );
    expect(transport).toHaveBeenCalledOnce();
  });

  it('times out once with a fixed error even when transport ignores abort', async () => {
    const transport = vi.fn(() => new Promise(() => undefined));
    const connector = createIbmWatsonxAiConnector({
      baseUrl: DALLAS,
      apiVersion: '2024-03-14',
      bearerToken: 'synthetic-bearer-token',
      timeoutMs: 1,
      transport,
    });
    await expectLocalError(
      () => connector.generateText(textProjectRequest()),
      'timeout',
      ['synthetic-bearer-token', 'synthetic prompt'],
    );
    expect(transport).toHaveBeenCalledOnce();
    const signal = transport.mock.calls[0]?.[0].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it('rejects cyclic and accessor-bearing response records safely', async () => {
    const cyclic: Record<string, unknown> = structuredClone(SYNTHETIC_TEXT_RESPONSE);
    cyclic.self = cyclic;
    const accessor = structuredClone(SYNTHETIC_TEXT_RESPONSE);
    let accessed = false;
    Object.defineProperty(accessor, 'model_id', {
      enumerable: true,
      get() {
        accessed = true;
        return SYNTHETIC_MODEL_ID;
      },
    });
    for (const body of [cyclic, accessor]) {
      const { connector } = setup(jsonResponse(body));
      await expectLocalError(
        () => connector.generateText(textProjectRequest()),
        'invalid_response',
      );
    }
    expect(accessed).toBe(false);
  });
});

describe('static dormant boundary', () => {
  it('contains no network client, environment lookup, retry, registration, gateway, or deployment code', () => {
    const source = readFileSync(join(__dirname, 'ibm-watsonx-ai.connector.ts'), 'utf8');
    for (const forbidden of [
      /\bfetch\s*\(/,
      /\baxios\b/,
      /\bhttps?\s*\./,
      /node:https?/,
      /process\.env/,
      /setInterval/,
      /\bretry\b/i,
      /gateway\/v1/,
      /deployments?\//,
      /connectors\.module/,
      /@ibm\//,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI21_NATIVE_CHAT_CONTRACT,
  AI21_NATIVE_LIMITS,
  buildAi21NativeChatRequest,
  classifyAi21NativeFailure,
  parseAi21NativeChatResponse,
  parseAi21NativeChatSse,
} from './contract';

const fixturesDirectory = join(__dirname, '__fixtures__');

function loadJsonFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixturesDirectory, name), 'utf8')) as Record<string, unknown>;
}

function loadTextFixture(name: string): string {
  return readFileSync(join(fixturesDirectory, name), 'utf8');
}

function validRequest(): Record<string, unknown> {
  return loadJsonFixture('request.valid.json');
}

function validResponse(): Record<string, unknown> {
  return loadJsonFixture('response.valid.json');
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen(Reflect.get(value, key), seen);
  }
}

function expectInvalid(action: () => unknown): void {
  expect(action).toThrowError('AI21_NATIVE_INVALID_INPUT');
}

function expectFixedInvalidError(action: () => unknown, forbiddenText?: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe('AI21_NATIVE_INVALID_INPUT');
  if (forbiddenText !== undefined) {
    expect((thrown as Error).message).not.toContain(forbiddenText);
  }
}

const CREDENTIAL_FIELD_ERROR = 'AI21_NATIVE_TEST_CREDENTIAL_FIELD';
const CREDENTIAL_KEYS = new Set([
  'token',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'clientsecret',
]);

function isExactAuthorizationMetadata(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) return false;
  const keys = Object.keys(descriptors);
  if (keys.length !== 2 || !keys.includes('scheme') || !keys.includes('owner')) return false;
  const scheme = descriptors.scheme;
  const owner = descriptors.owner;
  return (
    scheme !== undefined &&
    owner !== undefined &&
    'value' in scheme &&
    'value' in owner &&
    scheme.value === 'Bearer' &&
    owner.value === 'caller'
  );
}

function expectCredentialFreeOwnData(
  value: unknown,
  path: readonly string[] = [],
  seen = new WeakSet<object>(),
): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(CREDENTIAL_FIELD_ERROR);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error(CREDENTIAL_FIELD_ERROR);
    }

    const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
    if (normalizedKey === 'authorization') {
      if (path.length !== 0 || !isExactAuthorizationMetadata(descriptor.value)) {
        throw new Error(CREDENTIAL_FIELD_ERROR);
      }
      continue;
    }
    if (CREDENTIAL_KEYS.has(normalizedKey)) {
      throw new Error(CREDENTIAL_FIELD_ERROR);
    }
    expectCredentialFreeOwnData(descriptor.value, [...path, key], seen);
  }
}

describe('AI21 native contract metadata', () => {
  it('freezes the exact native SaaS identity without aliases or Bedrock', () => {
    expect(AI21_NATIVE_CHAT_CONTRACT).toStrictEqual({
      provider: 'ai21-native',
      service: 'ai21-platform-native-saas',
      apiVersion: 'v1',
      operation: 'chat.completions.create',
      method: 'POST',
      url: 'https://api.ai21.com/studio/v1/chat/completions',
      contentType: 'application/json',
      authorization: {
        scheme: 'Bearer',
        owner: 'caller',
      },
      models: ['jamba-large-1.7-2025-07', 'jamba-mini-2-2026-01'],
      retryCount: 0,
    });
    expectDeepFrozen(AI21_NATIVE_CHAT_CONTRACT);
    expect(JSON.stringify(AI21_NATIVE_CHAT_CONTRACT)).not.toMatch(/bedrock|aws|jamba-large"/i);
  });

  it('freezes every local implementation limit', () => {
    expect(AI21_NATIVE_LIMITS).toStrictEqual({
      maxDepth: 8,
      maxKeysPerObject: 32,
      maxArrayLength: 128,
      maxMessages: 128,
      maxChoices: 16,
      maxStringBytes: 262_144,
      maxAggregateInputBytes: 1_048_576,
      maxResponseBytes: 4_194_304,
      maxSseEvents: 8_192,
    });
    expectDeepFrozen(AI21_NATIVE_LIMITS);
  });
});

describe('buildAi21NativeChatRequest', () => {
  it('builds the fixed secret-free request descriptor from the synthetic fixture', () => {
    const descriptor = buildAi21NativeChatRequest(validRequest());

    expect(descriptor).toStrictEqual({
      provider: 'ai21-native',
      method: 'POST',
      url: 'https://api.ai21.com/studio/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
      },
      authorization: {
        scheme: 'Bearer',
        owner: 'caller',
      },
      retryCount: 0,
      body: {
        model: 'jamba-mini-2-2026-01',
        messages: [
          {
            role: 'system',
            content: 'This is a deterministic synthetic system message.',
          },
          {
            role: 'user',
            content: 'Return a deterministic synthetic answer.',
          },
          {
            role: 'assistant',
            content: 'Synthetic acknowledgement.',
          },
          {
            role: 'user',
            content: 'Continue with the synthetic fixture.',
          },
        ],
        max_tokens: 256,
        temperature: 0.4,
        top_p: 1,
        stop: ['SYNTHETIC_END'],
        n: 1,
        stream: false,
      },
    });
    expectDeepFrozen(descriptor);
    expect(() => expectCredentialFreeOwnData(descriptor)).not.toThrow();
  });

  it('allows documented token counters, exact authorization metadata, and ordinary content text', () => {
    expect(() =>
      expectCredentialFreeOwnData({
        max_tokens: 256,
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
        },
        content: 'The words token, API key, and authorization are ordinary content.',
        authorization: {
          scheme: 'Bearer',
          owner: 'caller',
        },
      }),
    ).not.toThrow();
  });

  it.each([
    ['token', { token: 'synthetic-secret-marker' }],
    ['API key', { apiKey: 'synthetic-secret-marker' }],
    ['access token', { access_token: 'synthetic-secret-marker' }],
    ['refresh token', { 'refresh-token': 'synthetic-secret-marker' }],
    ['ID token', { idToken: 'synthetic-secret-marker' }],
    ['auth token', { auth_token: 'synthetic-secret-marker' }],
    ['bearer token', { bearerToken: 'synthetic-secret-marker' }],
    ['client secret', { client_secret: 'synthetic-secret-marker' }],
    ['scalar authorization', { authorization: 'Bearer synthetic-secret-marker' }],
    ['Authorization header', { headers: { Authorization: 'Bearer synthetic-secret-marker' } }],
  ])('denies structural credential field %s', (_name, value) => {
    expect(() => expectCredentialFreeOwnData(value)).toThrowError(CREDENTIAL_FIELD_ERROR);
  });

  it('denies credential accessors without invoking them', () => {
    let accessed = false;
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, 'token', {
      enumerable: true,
      get() {
        accessed = true;
        return 'synthetic-secret-marker';
      },
    });

    expect(() => expectCredentialFreeOwnData(value)).toThrowError(CREDENTIAL_FIELD_ERROR);
    expect(accessed).toBe(false);
  });

  it.each(['jamba-large-1.7-2025-07', 'jamba-mini-2-2026-01'])(
    'accepts the frozen dated model %s',
    (model) => {
      expect(buildAi21NativeChatRequest({ ...validRequest(), model }).body.model).toBe(model);
    },
  );

  it('copies input before freezing so caller mutation cannot alter output', () => {
    const input = validRequest();
    const descriptor = buildAi21NativeChatRequest(input);
    const messages = input.messages as Array<Record<string, unknown>>;
    messages[0].content = 'mutated after validation';

    expect(descriptor.body.messages[0].content).toBe(
      'This is a deterministic synthetic system message.',
    );
    expectDeepFrozen(descriptor);
  });

  it.each(['apiVersion', 'operation', 'model', 'messages', 'max_tokens', 'n', 'stream'])(
    'rejects omitted required field %s',
    (key) => {
      const input = validRequest();
      delete input[key];
      expectInvalid(() => buildAi21NativeChatRequest(input));
    },
  );

  it.each([
    ['apiVersion', 'v2'],
    ['operation', 'completions.create'],
    ['model', 'jamba-large'],
    ['model', 'jamba-mini'],
    ['model', 'jamba-large-1.6-2025-03'],
    ['model', 'ai21.jamba-1-5-large-v1:0'],
    ['model', 'bedrock/jamba-large'],
  ])('rejects unsupported %s value %s', (key, value) => {
    expectInvalid(() => buildAi21NativeChatRequest({ ...validRequest(), [key]: value }));
  });

  it.each([
    'baseUrl',
    'url',
    'headers',
    'authorization',
    'apiKey',
    'transport',
    'retry',
    'tools',
    'tool_choice',
    'documents',
    'response_format',
    'batch',
    'maestro',
    'pagination',
    'region',
    'residency',
    'retain',
  ])('rejects denied request surface %s', (key) => {
    expectInvalid(() => buildAi21NativeChatRequest({ ...validRequest(), [key]: 'denied' }));
  });

  it.each([
    'token',
    'api_key',
    'api-key',
    'accessToken',
    'refresh_token',
    'id-token',
    'authToken',
    'bearer_token',
    'client-secret',
    'Authorization',
  ])('rejects credential-bearing request key %s with a fixed non-leaking error', (key) => {
    const sentinel = `synthetic-secret-sentinel-for-${key}`;
    expectFixedInvalidError(
      () => buildAi21NativeChatRequest({ ...validRequest(), [key]: sentinel }),
      sentinel,
    );
  });

  it.each([
    ['max_tokens', 0],
    ['max_tokens', 4_097],
    ['max_tokens', 1.5],
    ['temperature', -0.01],
    ['temperature', 2.01],
    ['top_p', -0.01],
    ['top_p', 1.01],
    ['n', 0],
    ['n', 17],
    ['n', 1.5],
  ])('rejects out-of-range %s value %s', (key, value) => {
    expectInvalid(() => buildAi21NativeChatRequest({ ...validRequest(), [key]: value }));
  });

  it('rejects stream with more than one choice', () => {
    expectInvalid(() =>
      buildAi21NativeChatRequest({
        ...validRequest(),
        n: 2,
        stream: true,
      }),
    );
  });

  it.each(['developer', 'tool', 'function', 'bedrock'])('rejects message role %s', (role) => {
    expectInvalid(() =>
      buildAi21NativeChatRequest({
        ...validRequest(),
        messages: [{ role, content: 'Synthetic content.' }],
      }),
    );
  });

  it('rejects accessors without invoking them', () => {
    const input = validRequest();
    let accessed = false;
    Object.defineProperty(input, 'model', {
      enumerable: true,
      get() {
        accessed = true;
        return 'jamba-mini-2-2026-01';
      },
    });

    expectInvalid(() => buildAi21NativeChatRequest(input));
    expect(accessed).toBe(false);
  });

  it('rejects exotic prototypes', () => {
    const input = validRequest();
    Object.setPrototypeOf(input, { inherited: 'denied' });
    expectInvalid(() => buildAi21NativeChatRequest(input));
  });

  it.each(['__proto__', 'prototype', 'constructor'])('rejects pollution key %s', (key) => {
    const input = validRequest();
    Object.defineProperty(input, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 'denied',
    });
    expectInvalid(() => buildAi21NativeChatRequest(input));
  });

  it('rejects cyclic values', () => {
    const input = validRequest();
    input.self = input;
    expectInvalid(() => buildAi21NativeChatRequest(input));
  });

  it('rejects values deeper than the local depth limit', () => {
    const input = validRequest();
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let index = 0; index < 9; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    input.extra = root;
    expectInvalid(() => buildAi21NativeChatRequest(input));
  });

  it('rejects objects wider than the local key limit', () => {
    const wide = Object.fromEntries(
      Array.from({ length: AI21_NATIVE_LIMITS.maxKeysPerObject + 1 }, (_, index) => [
        `key${index}`,
        index,
      ]),
    );
    expectInvalid(() => buildAi21NativeChatRequest({ ...validRequest(), extra: wide }));
  });

  it('rejects arrays and message lists beyond local count limits', () => {
    const messages = Array.from({ length: AI21_NATIVE_LIMITS.maxMessages + 1 }, (_, index) => ({
      role: 'user',
      content: `Synthetic message ${index}`,
    }));
    expectInvalid(() => buildAi21NativeChatRequest({ ...validRequest(), messages }));
    expectInvalid(() =>
      buildAi21NativeChatRequest({
        ...validRequest(),
        stop: Array.from({ length: AI21_NATIVE_LIMITS.maxArrayLength + 1 }, () => 'x'),
      }),
    );
  });

  it('rejects one oversized string and oversized aggregate request bytes', () => {
    const oversized = 'x'.repeat(AI21_NATIVE_LIMITS.maxStringBytes + 1);
    expectInvalid(() =>
      buildAi21NativeChatRequest({
        ...validRequest(),
        messages: [{ role: 'user', content: oversized }],
      }),
    );

    const aggregateMessages = Array.from({ length: 5 }, (_, index) => ({
      role: 'user',
      content: `${index}${'x'.repeat(239_999)}`,
    }));
    expectInvalid(() =>
      buildAi21NativeChatRequest({
        ...validRequest(),
        messages: aggregateMessages,
      }),
    );
  });
});

describe('parseAi21NativeChatResponse', () => {
  it('normalizes and deeply freezes the synthetic response fixture', () => {
    const response = parseAi21NativeChatResponse(validResponse());

    expect(response).toStrictEqual({
      id: 'synthetic-ai21-request-001',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Synthetic answer.',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      },
    });
    expectDeepFrozen(response);
  });

  it('copies response input before freezing', () => {
    const input = validResponse();
    const response = parseAi21NativeChatResponse(input);
    const choices = input.choices as Array<Record<string, unknown>>;
    (choices[0].message as Record<string, unknown>).content = 'mutated';

    expect(response.choices[0].message.content).toBe('Synthetic answer.');
  });

  it.each(['id', 'choices', 'usage'])('rejects omitted response field %s', (key) => {
    const input = validResponse();
    delete input[key];
    expectInvalid(() => parseAi21NativeChatResponse(input));
  });

  it('rejects extra response and nested choice fields', () => {
    expectInvalid(() =>
      parseAi21NativeChatResponse({
        ...validResponse(),
        model: 'jamba-mini-2-2026-01',
      }),
    );

    const input = validResponse();
    const choices = input.choices as Array<Record<string, unknown>>;
    choices[0].logprobs = null;
    expectInvalid(() => parseAi21NativeChatResponse(input));
  });

  it('rejects empty, excessive, or duplicate choice indexes', () => {
    expectInvalid(() => parseAi21NativeChatResponse({ ...validResponse(), choices: [] }));

    const sourceChoice = (validResponse().choices as Array<Record<string, unknown>>)[0];
    const tooMany = Array.from({ length: AI21_NATIVE_LIMITS.maxChoices + 1 }, (_, index) => ({
      ...sourceChoice,
      index,
      message: { role: 'assistant', content: `Synthetic ${index}` },
    }));
    expectInvalid(() => parseAi21NativeChatResponse({ ...validResponse(), choices: tooMany }));

    expectInvalid(() =>
      parseAi21NativeChatResponse({
        ...validResponse(),
        choices: [
          sourceChoice,
          {
            ...sourceChoice,
            message: { role: 'assistant', content: 'Second synthetic answer.' },
          },
        ],
      }),
    );
  });

  it.each([
    ['message.role', 'user'],
    ['message.content', null],
    ['finish_reason', 'tool_calls'],
    ['finish_reason', null],
  ])('rejects unsupported response %s value', (path, value) => {
    const input = validResponse();
    const choice = (input.choices as Array<Record<string, unknown>>)[0];
    if (path === 'message.role' || path === 'message.content') {
      const message = choice.message as Record<string, unknown>;
      message[path.split('.')[1]] = value;
    } else {
      choice.finish_reason = value;
    }
    expectInvalid(() => parseAi21NativeChatResponse(input));
  });

  it('rejects negative, non-integer, and inconsistent usage', () => {
    expectInvalid(() =>
      parseAi21NativeChatResponse({
        ...validResponse(),
        usage: { prompt_tokens: -1, completion_tokens: 3, total_tokens: 2 },
      }),
    );
    expectInvalid(() =>
      parseAi21NativeChatResponse({
        ...validResponse(),
        usage: { prompt_tokens: 1.5, completion_tokens: 3, total_tokens: 4.5 },
      }),
    );
    expectInvalid(() =>
      parseAi21NativeChatResponse({
        ...validResponse(),
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 99 },
      }),
    );
  });

  it('rejects response accessors, cycles, and oversized strings', () => {
    const accessor = validResponse();
    let accessed = false;
    Object.defineProperty(accessor, 'id', {
      enumerable: true,
      get() {
        accessed = true;
        return 'denied';
      },
    });
    expectInvalid(() => parseAi21NativeChatResponse(accessor));
    expect(accessed).toBe(false);

    const cyclic = validResponse();
    cyclic.self = cyclic;
    expectInvalid(() => parseAi21NativeChatResponse(cyclic));

    const oversized = validResponse();
    const choice = (oversized.choices as Array<Record<string, unknown>>)[0];
    (choice.message as Record<string, unknown>).content = 'x'.repeat(
      AI21_NATIVE_LIMITS.maxStringBytes + 1,
    );
    expectInvalid(() => parseAi21NativeChatResponse(oversized));
  });
});

describe('parseAi21NativeChatSse', () => {
  it('parses, aggregates, and freezes the synthetic SSE transcript', () => {
    const parsed = parseAi21NativeChatSse(loadTextFixture('stream.valid.sse'));

    expect(parsed).toStrictEqual({
      id: 'synthetic-ai21-stream-001',
      role: 'assistant',
      content: 'Synthetic answer.',
      finish_reason: 'stop',
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      },
      event_count: 3,
    });
    expectDeepFrozen(parsed);
  });

  it.each([
    ['malformed JSON', 'data: {not-json}\n\ndata: [DONE]\n'],
    ['missing DONE', loadTextFixture('stream.valid.sse').replace('data: [DONE]\n', '')],
    ['duplicate DONE', `${loadTextFixture('stream.valid.sse')}\ndata: [DONE]\n`],
    [
      'data after DONE',
      `${loadTextFixture('stream.valid.sse')}\ndata: {"id":"late","choices":[],"usage":null}\n`,
    ],
    [
      'mixed request IDs',
      loadTextFixture('stream.valid.sse').replace(
        '"synthetic-ai21-stream-001","choices":[{"index":0,"delta":{"content":"Synthetic "}',
        '"different-request","choices":[{"index":0,"delta":{"content":"Synthetic "}',
      ),
    ],
    [
      'missing first assistant role',
      loadTextFixture('stream.valid.sse').replace(
        '{"role":"assistant"}',
        '{"content":"wrong-first-delta"}',
      ),
    ],
    [
      'missing terminal usage',
      loadTextFixture('stream.valid.sse').replace(
        '"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}',
        '"usage":null',
      ),
    ],
    [
      'unsupported finish reason',
      loadTextFixture('stream.valid.sse').replace(
        '"finish_reason":"stop"',
        '"finish_reason":"tool_calls"',
      ),
    ],
    [
      'extra chunk field',
      loadTextFixture('stream.valid.sse').replace(
        '"usage":null}',
        '"usage":null,"model":"denied"}',
      ),
    ],
  ])('rejects %s', (_name, transcript) => {
    expectInvalid(() => parseAi21NativeChatSse(transcript));
  });

  it('rejects transcript byte and event-count overflows', () => {
    expectInvalid(() =>
      parseAi21NativeChatSse('x'.repeat(AI21_NATIVE_LIMITS.maxResponseBytes + 1)),
    );

    const first =
      'data: {"id":"synthetic-overflow","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}],"usage":null}\n\n';
    const middle =
      'data: {"id":"synthetic-overflow","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}],"usage":null}\n\n';
    const overflowing = `${first}${middle.repeat(AI21_NATIVE_LIMITS.maxSseEvents)}data: [DONE]\n`;
    expectInvalid(() => parseAi21NativeChatSse(overflowing));
  });

  it('rejects non-string transcript input', () => {
    expectInvalid(() => parseAi21NativeChatSse({ data: '[DONE]' }));
  });
});

describe('classifyAi21NativeFailure', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'access_denied'],
    [422, 'invalid_request'],
    [429, 'rate_limited'],
    [500, 'internal_error'],
    [503, 'unavailable'],
    [418, 'upstream_error'],
  ])('redacts HTTP %s as %s with zero retry', (status, code) => {
    const failure = classifyAi21NativeFailure({ kind: 'http', status });

    expect(failure).toStrictEqual({
      provider: 'ai21-native',
      code,
      status,
      retry: false,
    });
    expectDeepFrozen(failure);
  });

  it('classifies a caller-declared timeout without duration or upstream details', () => {
    const failure = classifyAi21NativeFailure({ kind: 'timeout' });
    expect(failure).toStrictEqual({
      provider: 'ai21-native',
      code: 'timeout',
      retry: false,
    });
    expectDeepFrozen(failure);
  });

  it.each([
    null,
    {},
    { kind: 'http' },
    { kind: 'http', status: 399 },
    { kind: 'http', status: 600 },
    { kind: 'http', status: 429.5 },
    { kind: 'network' },
    { kind: 'timeout', timeoutMs: 1 },
    { kind: 'http', status: 401, body: 'secret-body-marker' },
    { kind: 'http', status: 401, headers: { Authorization: 'secret-token-marker' } },
    new Error('secret-exception-marker'),
  ])('rejects malformed or detail-bearing failure input', (input) => {
    expectFixedInvalidError(() => classifyAi21NativeFailure(input));
  });

  it('rejects a failure accessor without invoking it or leaking its value', () => {
    let accessed = false;
    const input: Record<string, unknown> = { kind: 'http' };
    Object.defineProperty(input, 'status', {
      enumerable: true,
      get() {
        accessed = true;
        return 401;
      },
    });

    expectFixedInvalidError(() => classifyAi21NativeFailure(input));
    expect(accessed).toBe(false);
  });
});

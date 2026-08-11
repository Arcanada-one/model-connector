import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NVIDIA_SAFETY_NIM_CONTRACT_VERSION,
  NVIDIA_SAFETY_NIM_MODEL,
  NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
  NvidiaSafetyNimConnector,
  NvidiaSafetyNimError,
  type NvidiaSafetyNimTransport,
  type NvidiaSafetyNimTransportRequest,
} from './nvidia-safety-nim.connector';

const fixturesDir = join(__dirname, '__fixtures__');
const successFixture = JSON.parse(
  readFileSync(join(fixturesDir, 'success.synthetic.json'), 'utf8'),
) as unknown;
const providerErrorFixture = JSON.parse(
  readFileSync(join(fixturesDir, 'provider-error.synthetic.json'), 'utf8'),
) as unknown;

const SUCCESS_FIXTURE_SHA256 =
  'e103cf8fdc904fcbbe4955298a37d05fe9a97d493042305d2064b7b77c9de3d4';
const ERROR_FIXTURE_SHA256 =
  '9cec43cd8310e9db9bbfa9a8bce61a5c4628bc5c3ab605c4fd828d9fc36d372c';

const baseConfig = () => ({
  contractVersion: 'nvidia-safety-nim/v1',
  deployment: 'caller-operated-nim',
  baseUrl: 'http://127.0.0.1:18000/nim/',
  model: 'nvidia/nemotron-3.5-content-safety',
  timeoutMs: 1_000,
});

const makeTransport = (implementation: () => Promise<unknown>) => {
  const send = vi.fn(implementation);
  const transport: NvidiaSafetyNimTransport = { send };
  return { transport, send };
};

const validRequest = () => ({
  prompt: 'synthetic prompt text',
  includeCategories: false,
});

const captureError = async (promise: Promise<unknown>): Promise<NvidiaSafetyNimError> => {
  try {
    await promise;
    throw new Error('expected rejection');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(NvidiaSafetyNimError);
    return error as NvidiaSafetyNimError;
  }
};

describe('NvidiaSafetyNimConnector frozen AU-036 boundary', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pins only the exact current model and connector-owned contracts', () => {
    expect(NVIDIA_SAFETY_NIM_MODEL).toBe('nvidia/nemotron-3.5-content-safety');
    expect(NVIDIA_SAFETY_NIM_CONTRACT_VERSION).toBe('nvidia-safety-nim/v1');
    expect(NVIDIA_SAFETY_NIM_TRANSPORT_VERSION).toBe(
      'nvidia-safety-nim-transport/v1',
    );
  });

  it('requires exact explicit caller-operated configuration and an injected transport', () => {
    const { transport } = makeTransport(async () => ({
      contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
      status: 200,
      content: 'User Safety: safe',
    }));
    expect(() => new NvidiaSafetyNimConnector(baseConfig(), transport)).not.toThrow();

    for (const config of [
      null,
      {},
      { ...baseConfig(), contractVersion: 'v2' },
      { ...baseConfig(), deployment: 'hosted' },
      { ...baseConfig(), model: 'nvidia/nemotron-3-content-safety' },
      { ...baseConfig(), timeoutMs: 0 },
      { ...baseConfig(), timeoutMs: 30_001 },
      { ...baseConfig(), timeoutMs: 1.5 },
      { ...baseConfig(), auth: { type: 'bearer', token: 'forbidden' } },
    ]) {
      expect(() => new NvidiaSafetyNimConnector(config, transport)).toThrowError(
        expect.objectContaining({ code: 'invalid_configuration' }),
      );
    }

    for (const invalidTransport of [
      null,
      {},
      { send: 'not-a-function' },
      { send: async () => successFixture, retry: true },
    ]) {
      expect(() => new NvidiaSafetyNimConnector(baseConfig(), invalidTransport)).toThrowError(
        expect.objectContaining({ code: 'invalid_configuration' }),
      );
    }
  });

  it('normalizes only safe explicit base URLs and rejects metadata or credential-bearing hosts', () => {
    const { transport } = makeTransport(async () => successFixture);
    for (const baseUrl of [
      'ftp://127.0.0.1:8000',
      'http://user:password@127.0.0.1:8000',
      'http://127.0.0.1:8000?token=x',
      'http://127.0.0.1:8000#fragment',
      'http://0.0.0.0:8000',
      'http://[::]:8000',
      'http://169.254.169.254/latest',
      'http://100.100.100.200/latest',
      'http://metadata.google.internal/latest',
      `http://${'a'.repeat(2_049)}.invalid`,
    ]) {
      expect(
        () => new NvidiaSafetyNimConnector({ ...baseConfig(), baseUrl }, transport),
      ).toThrowError(expect.objectContaining({ code: 'invalid_configuration' }));
    }
  });

  it('accepts null-prototype records but rejects inherited, accessor, symbol, and exotic configuration', () => {
    const { transport } = makeTransport(async () => successFixture);
    const nullPrototype = Object.assign(
      Object.create(null) as Record<string, unknown>,
      baseConfig(),
    );
    expect(() => new NvidiaSafetyNimConnector(nullPrototype, transport)).not.toThrow();

    const inherited = Object.create(baseConfig()) as Record<string, unknown>;
    const accessor = { ...baseConfig() } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessor, 'model', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return NVIDIA_SAFETY_NIM_MODEL;
      },
    });
    const symbolConfig = { ...baseConfig(), [Symbol('hidden')]: true };
    const exotic = Object.assign(new (class Configuration {})(), baseConfig());

    for (const config of [inherited, accessor, symbolConfig, exotic]) {
      expect(() => new NvidiaSafetyNimConnector(config, transport)).toThrowError(
        expect.objectContaining({ code: 'invalid_configuration' }),
      );
    }
    expect(getterCalls).toBe(0);
  });

  it('builds the exact text-only caller-operated NIM request', async () => {
    const { transport, send } = makeTransport(async () => ({
      contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
      status: 200,
      content: 'User Safety: safe',
    }));
    const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);

    const result = await connector.classify(validRequest());

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      contractVersion: 'nvidia-safety-nim-transport/v1',
      method: 'POST',
      url: 'http://127.0.0.1:18000/nim/v1/chat/completions',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: {
        model: 'nvidia/nemotron-3.5-content-safety',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'synthetic prompt text' }],
          },
        ],
        max_tokens: 100,
        temperature: 0.01,
        top_p: 0.95,
        chat_template_kwargs: {
          request_categories: '/no_categories',
          enable_thinking: false,
        },
      },
      timeoutMs: 1_000,
    });
    expect(result).toEqual({
      contractVersion: NVIDIA_SAFETY_NIM_CONTRACT_VERSION,
      model: NVIDIA_SAFETY_NIM_MODEL,
      userSafety: 'safe',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(['image/gif', 'image/jpeg', 'image/png'] as const)(
    'constructs one inline %s image without remote fetch',
    async (mediaType) => {
      const { transport, send } = makeTransport(async () => ({
        contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
        status: 200,
        content: 'User Safety: safe',
      }));
      const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
      await connector.classify({
        ...validRequest(),
        image: { mediaType, base64: 'AQID' },
      });
      const sent = send.mock.calls[0]?.[0] as NvidiaSafetyNimTransportRequest;
      expect(sent.body.messages[0]?.content).toEqual([
        { type: 'text', text: 'synthetic prompt text' },
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,AQID` } },
      ]);
    },
  );

  it('constructs optional response, category, and custom-policy fields exactly', async () => {
    const { transport, send } = makeTransport(async () => successFixture);
    const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
    const result = await connector.classify({
      prompt: 'synthetic prompt text',
      response: 'synthetic assistant response',
      includeCategories: true,
      customPolicy: 'synthetic custom policy',
    });

    const sent = send.mock.calls[0]?.[0] as NvidiaSafetyNimTransportRequest;
    expect(sent.body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'synthetic prompt text' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'synthetic assistant response' }],
      },
    ]);
    expect(sent.body.chat_template_kwargs).toEqual({
      request_categories: '/categories',
      enable_thinking: false,
      custom_policy: 'synthetic custom policy',
    });
    expect(result).toEqual({
      contractVersion: NVIDIA_SAFETY_NIM_CONTRACT_VERSION,
      model: NVIDIA_SAFETY_NIM_MODEL,
      userSafety: 'unsafe',
      responseSafety: 'safe',
      safetyCategories: 'Criminal Planning/Confessions',
    });
  });

  it('parses only evidence-matched safety line combinations', async () => {
    const cases: Array<{
      request: unknown;
      content: string;
      expected: Record<string, unknown>;
    }> = [
      {
        request: validRequest(),
        content: 'User Safety: unsafe',
        expected: { userSafety: 'unsafe' },
      },
      {
        request: { ...validRequest(), response: 'synthetic response' },
        content: 'User Safety: safe\nResponse Safety: unsafe',
        expected: { userSafety: 'safe', responseSafety: 'unsafe' },
      },
      {
        request: { ...validRequest(), includeCategories: true },
        content: 'User Safety: unsafe\nSafety Categories: Category A, Category B/Subtype',
        expected: {
          userSafety: 'unsafe',
          safetyCategories: 'Category A, Category B/Subtype',
        },
      },
    ];

    for (const testCase of cases) {
      const { transport } = makeTransport(async () => ({
        contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
        status: 200,
        content: testCase.content,
      }));
      const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
      await expect(connector.classify(testCase.request)).resolves.toMatchObject(
        testCase.expected,
      );
    }
  });

  it.each([
    '',
    'User Safety: SAFE',
    'User Safety: safe ',
    ' User Safety: safe',
    'User Safety: safe\n',
    'User Safety: safe\r\nResponse Safety: safe',
    'Response Safety: safe',
    'User Safety: maybe',
    'User Safety: safe\nResponse Safety: safe',
    'User Safety: unsafe\nSafety Categories: Category A',
    'User Safety: unsafe\nreasoning: synthetic',
    '{"User Safety":"safe"}',
  ])('rejects malformed, ambiguous, or request-inconsistent output %#', async (content) => {
    const { transport } = makeTransport(async () => ({
      contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
      status: 200,
      content,
    }));
    const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
    const error = await captureError(connector.classify(validRequest()));
    expect(error.code).toBe('invalid_response');
    if (content.length > 0) {
      expect(error.message).not.toContain(content);
    }
  });

  it.each([
    'User Safety: unsafe\nSafety Categories: ',
    'User Safety: unsafe\nSafety Categories: Category A,',
    'User Safety: unsafe\nSafety Categories: Category A,,Category B',
    'User Safety: unsafe\nSafety Categories:  Category A',
    'User Safety: unsafe\nSafety Categories: Category A,  Category B',
  ])('rejects malformed opaque category strings %#', async (content) => {
    const { transport } = makeTransport(async () => ({
      contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
      status: 200,
      content,
    }));
    const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
    const error = await captureError(
      connector.classify({ ...validRequest(), includeCategories: true }),
    );
    expect(error.code).toBe('invalid_response');
  });

  it('rejects omitted, extra, wrong-type, dangerous, deep, wide, cyclic, and accessor requests', async () => {
    const { transport, send } = makeTransport(async () => successFixture);
    const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
    const cyclic: Record<string, unknown> = { ...validRequest() };
    cyclic.extra = cyclic;
    const deep = { ...validRequest(), extra: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } };
    const wide = {
      ...validRequest(),
      ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`x${index}`, index])),
    };
    const inherited = Object.create(validRequest()) as Record<string, unknown>;
    const dangerous = JSON.parse(
      '{"prompt":"x","includeCategories":false,"__proto__":{"polluted":true}}',
    ) as unknown;
    const accessor = { includeCategories: false } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessor, 'prompt', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'must not be read';
      },
    });

    for (const request of [
      null,
      [],
      {},
      { prompt: 'x' },
      { prompt: '', includeCategories: false },
      { prompt: 1, includeCategories: false },
      { prompt: 'x', includeCategories: 'false' },
      { ...validRequest(), model: NVIDIA_SAFETY_NIM_MODEL },
      { ...validRequest(), stream: false },
      { ...validRequest(), image: { mediaType: 'image/webp', base64: 'AQID' } },
      { ...validRequest(), image: { mediaType: 'image/png', base64: 'not base64!' } },
      { ...validRequest(), image: { mediaType: 'image/png', base64: 'http://example.invalid' } },
      { ...validRequest(), response: '' },
      { ...validRequest(), customPolicy: '' },
      inherited,
      dangerous,
      accessor,
      cyclic,
      deep,
      wide,
      { ...validRequest(), [Symbol('hidden')]: true },
      Object.assign(new (class Request {})(), validRequest()),
    ]) {
      const error = await captureError(connector.classify(request));
      expect(error.code).toBe('invalid_request');
    }
    expect(getterCalls).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('enforces text code-unit and UTF-8 byte ceilings', async () => {
    const { transport, send } = makeTransport(async () => ({
      contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
      status: 200,
      content: 'User Safety: safe',
    }));
    const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
    await expect(
      connector.classify({ prompt: 'x'.repeat(16_384), includeCategories: false }),
    ).resolves.toMatchObject({ userSafety: 'safe' });

    for (const prompt of ['x'.repeat(16_385), '😀'.repeat(16_384)]) {
      const error = await captureError(
        connector.classify({ prompt, includeCategories: false }),
      );
      expect(error.code).toBe('invalid_request');
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('enforces canonical base64 and the decoded five-MiB image ceiling', async () => {
    const { transport, send } = makeTransport(async () => ({
      contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
      status: 200,
      content: 'User Safety: safe',
    }));
    const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
    const exact = Buffer.alloc(5 * 1024 * 1024, 0xab).toString('base64');
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0xab).toString('base64');

    await expect(
      connector.classify({
        ...validRequest(),
        image: { mediaType: 'image/png', base64: exact },
      }),
    ).resolves.toMatchObject({ userSafety: 'safe' });
    const error = await captureError(
      connector.classify({
        ...validRequest(),
        image: { mediaType: 'image/png', base64: oversized },
      }),
    );
    expect(error.code).toBe('invalid_request');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('passes a fresh deeply frozen request and returns a fresh frozen result', async () => {
    let release: (() => void) | undefined;
    let injected: NvidiaSafetyNimTransportRequest | undefined;
    const send = vi.fn(
      (request: NvidiaSafetyNimTransportRequest) =>
        new Promise<unknown>((resolvePromise) => {
          injected = request;
          release = () =>
            resolvePromise({
              contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
              status: 200,
              content: 'User Safety: safe',
            });
        }),
    );
    const connector = new NvidiaSafetyNimConnector(baseConfig(), { send });
    const request = {
      prompt: 'original synthetic prompt',
      includeCategories: false,
      image: { mediaType: 'image/png' as const, base64: 'AQID' },
    };
    const pending = connector.classify(request);
    request.prompt = 'caller mutation';
    request.image.base64 = 'BAUG';
    release?.();
    const result = await pending;

    expect(injected).toBeDefined();
    expect(Object.isFrozen(injected)).toBe(true);
    expect(Object.isFrozen(injected?.headers)).toBe(true);
    expect(Object.isFrozen(injected?.body)).toBe(true);
    expect(Object.isFrozen(injected?.body.messages)).toBe(true);
    expect(Object.isFrozen(injected?.body.messages[0]?.content)).toBe(true);
    expect(injected?.body.messages[0]?.content).toEqual([
      { type: 'text', text: 'original synthetic prompt' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects every unsafe normalized transport response shape', async () => {
    const accessor = {
      contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
      status: 200,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'content', {
      enumerable: true,
      get: () => 'User Safety: safe',
    });
    const cyclic: Record<string, unknown> = {
      contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
      status: 200,
      content: 'User Safety: safe',
    };
    cyclic.extra = cyclic;

    const values: unknown[] = [
      null,
      'User Safety: safe',
      {},
      { contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION, status: 200 },
      { contractVersion: 'v2', status: 200, content: 'User Safety: safe' },
      { contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION, status: 202 },
      { contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION, status: 200.5, content: 'User Safety: safe' },
      { contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION, status: 200, content: 1 },
      { ...successFixture as Record<string, unknown>, extra: true },
      accessor,
      cyclic,
      { ...successFixture as Record<string, unknown>, [Symbol('hidden')]: true },
      Object.assign(new (class Response {})(), successFixture as object),
      {
        contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
        status: 200,
        content: 'x'.repeat(4_097),
      },
    ];

    for (const value of values) {
      const { transport } = makeTransport(async () => value);
      const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
      const error = await captureError(connector.classify(validRequest()));
      expect(error.code).toBe('invalid_response');
    }
  });

  it('maps exact provider failure envelopes without parsing or leaking content', async () => {
    const { transport, send } = makeTransport(async () => providerErrorFixture);
    const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
    const error = await captureError(connector.classify(validRequest()));
    expect(error).toMatchObject({
      code: 'provider_error',
      message: 'NVIDIA Safety NIM provider rejected the request',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('503');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('times out deterministically, calls once, and never retries', async () => {
    vi.useFakeTimers();
    const { transport, send } = makeTransport(
      () => new Promise<unknown>(() => undefined),
    );
    const connector = new NvidiaSafetyNimConnector(
      { ...baseConfig(), timeoutMs: 25 },
      transport,
    );
    const pending = connector.classify(validRequest());
    await vi.advanceTimersByTimeAsync(25);
    const error = await captureError(pending);
    expect(error).toMatchObject({
      code: 'transport_timeout',
      message: 'NVIDIA Safety NIM transport timed out',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('redacts caller input, provider output, and raw transport causes', async () => {
    const inputSecret = 'PRIVATE_INPUT_SENTINEL';
    const outputSecret = 'PRIVATE_OUTPUT_SENTINEL';
    const causeSecret = 'PRIVATE_CAUSE_SENTINEL';

    const failed = makeTransport(async () => Promise.reject(new Error(causeSecret)));
    const failedConnector = new NvidiaSafetyNimConnector(baseConfig(), failed.transport);
    const transportError = await captureError(
      failedConnector.classify({ prompt: inputSecret, includeCategories: false }),
    );
    expect(transportError).toMatchObject({
      code: 'transport_failure',
      message: 'NVIDIA Safety NIM transport failed',
    });
    expect(transportError).not.toHaveProperty('cause');
    expect(JSON.stringify(transportError)).not.toContain(inputSecret);
    expect(JSON.stringify(transportError)).not.toContain(causeSecret);

    const malformed = makeTransport(async () => ({
      contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
      status: 200,
      content: outputSecret,
    }));
    const malformedConnector = new NvidiaSafetyNimConnector(
      baseConfig(),
      malformed.transport,
    );
    const responseError = await captureError(
      malformedConnector.classify({ prompt: inputSecret, includeCategories: false }),
    );
    expect(responseError).toMatchObject({
      code: 'invalid_response',
      message: 'NVIDIA Safety NIM response was rejected',
    });
    expect(JSON.stringify(responseError)).not.toContain(inputSecret);
    expect(JSON.stringify(responseError)).not.toContain(outputSecret);
  });

  it('uses no global fetch and exposes no registration or deployment lifecycle', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not run'));
    const { transport } = makeTransport(async () => ({
      contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
      status: 200,
      content: 'User Safety: safe',
    }));
    const connector = new NvidiaSafetyNimConnector(baseConfig(), transport);
    await expect(connector.classify(validRequest())).resolves.toMatchObject({
      userSafety: 'safe',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const field of ['auth', 'discover', 'health', 'register', 'retry', 'stream']) {
      expect(connector).not.toHaveProperty(field);
    }
  });

  it('keeps production free of network, credential, process, and registration behavior', () => {
    const source = readFileSync(
      resolve(__dirname, 'nvidia-safety-nim.connector.ts'),
      'utf8',
    );
    for (const forbidden of [
      /\bfetch\s*\(/,
      /from ['"](?:node:)?(?:http|https|net|tls|dns|child_process|fs)['"]/,
      /process\.env/,
      /\bspawn\s*\(/,
      /\bexec\s*\(/,
      /Authorization/,
      /integrate\.api\.nvidia\.com/,
      /@Module\s*\(/,
      /@Injectable\s*\(/,
      /NeMo\s+Guardrails/i,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it('locks exact handwritten deterministic synthetic fixture provenance', () => {
    const successPath = join(fixturesDir, 'success.synthetic.json');
    const errorPath = join(fixturesDir, 'provider-error.synthetic.json');
    expect(createHash('sha256').update(readFileSync(successPath)).digest('hex')).toBe(
      SUCCESS_FIXTURE_SHA256,
    );
    expect(createHash('sha256').update(readFileSync(errorPath)).digest('hex')).toBe(
      ERROR_FIXTURE_SHA256,
    );
    const provenance = readFileSync(join(fixturesDir, 'README.md'), 'utf8');
    expect(provenance).toContain(SUCCESS_FIXTURE_SHA256);
    expect(provenance).toContain(ERROR_FIXTURE_SHA256);
    expect(provenance).toContain('never captured, copied, replayed');
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  ORACLE_OCI_GENERATIVE_AI_API_VERSION,
  ORACLE_OCI_GENERATIVE_AI_LIMITS,
  ORACLE_OCI_GENERATIVE_AI_REGIONS,
  OracleOciGenerativeAiError,
  createOracleOciGenerativeAiConnector,
  type OracleOciAuthorizedTransport,
  type OracleOciTransportRequest,
  type OracleOciTransportResponse,
} from './oracle-oci-generative-ai.connector';
import {
  SYNTHETIC_COMPARTMENT_ID,
  SYNTHETIC_DEDICATED_BODY,
  SYNTHETIC_ENDPOINT_COLLECTION,
  SYNTHETIC_JSON_RESPONSE,
  SYNTHETIC_ON_DEMAND_BODY,
  SYNTHETIC_WORK_REQUEST,
  SYNTHETIC_WORK_REQUEST_ID,
} from './synthetic-fixtures';

const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });

function response(
  body: unknown = SYNTHETIC_JSON_RESPONSE,
  headers: Readonly<Record<string, string>> = JSON_HEADERS,
): OracleOciTransportResponse {
  return { status: 200, headers, body };
}

function setup(
  transportImplementation: OracleOciAuthorizedTransport = vi.fn(async () => response()),
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const transport = vi.fn(transportImplementation);
  const connector = createOracleOciGenerativeAiConnector({
    region: 'us-ashburn-1',
    apiVersion: ORACLE_OCI_GENERATIVE_AI_API_VERSION,
    timeoutMs: 1_000,
    transport,
    ...overrides,
  });
  return { connector, transport };
}

async function capturedRequest(
  invoke: (
    connector: ReturnType<typeof createOracleOciGenerativeAiConnector>,
  ) => Promise<unknown>,
): Promise<OracleOciTransportRequest> {
  const { connector, transport } = setup();
  await invoke(connector);
  expect(transport).toHaveBeenCalledTimes(1);
  return transport.mock.calls[0]![0];
}

function expectCode(code: string) {
  return expect.objectContaining({ code });
}

describe('Oracle OCI Generative AI frozen identity', () => {
  it('freezes the dated API and all current region/realm mappings', () => {
    expect(ORACLE_OCI_GENERATIVE_AI_API_VERSION).toBe('20231130');
    expect(ORACLE_OCI_GENERATIVE_AI_REGIONS).toEqual({
      'sa-saopaulo-1': 'oraclecloud.com',
      'eu-frankfurt-1': 'oraclecloud.com',
      'ap-hyderabad-1': 'oraclecloud.com',
      'ap-osaka-1': 'oraclecloud.com',
      'me-riyadh-1': 'oraclecloud.com',
      'me-abudhabi-1': 'oraclecloud.com',
      'me-dubai-1': 'oraclecloud.com',
      'uk-london-1': 'oraclecloud.com',
      'us-ashburn-1': 'oraclecloud.com',
      'us-chicago-1': 'oraclecloud.com',
      'us-phoenix-1': 'oraclecloud.com',
      'uk-gov-london-1': 'oraclegovcloud.uk',
      'eu-frankfurt-2': 'oraclecloud.eu',
    });
    expect(Object.isFrozen(ORACLE_OCI_GENERATIVE_AI_REGIONS)).toBe(true);
  });

  it.each([
    ['sa-saopaulo-1', 'oraclecloud.com'],
    ['eu-frankfurt-1', 'oraclecloud.com'],
    ['ap-hyderabad-1', 'oraclecloud.com'],
    ['ap-osaka-1', 'oraclecloud.com'],
    ['me-riyadh-1', 'oraclecloud.com'],
    ['me-abudhabi-1', 'oraclecloud.com'],
    ['me-dubai-1', 'oraclecloud.com'],
    ['uk-london-1', 'oraclecloud.com'],
    ['us-ashburn-1', 'oraclecloud.com'],
    ['us-chicago-1', 'oraclecloud.com'],
    ['us-phoenix-1', 'oraclecloud.com'],
    ['uk-gov-london-1', 'oraclegovcloud.uk'],
    ['eu-frankfurt-2', 'oraclecloud.eu'],
  ] as const)('derives both service hosts for %s', async (region, realmDomain) => {
    const transport = vi.fn<OracleOciAuthorizedTransport>(async () => response());
    const connector = createOracleOciGenerativeAiConnector({
      region,
      apiVersion: '20231130',
      timeoutMs: 1_000,
      transport,
    });
    await connector.chat({ body: SYNTHETIC_ON_DEMAND_BODY });
    await connector.listModels({ compartmentId: SYNTHETIC_COMPARTMENT_ID });
    expect(transport.mock.calls[0]![0].url).toBe(
      `https://inference.generativeai.${region}.oci.${realmDomain}/20231130/actions/chat`,
    );
    expect(transport.mock.calls[1]![0].url).toBe(
      `https://generativeai.${region}.oci.${realmDomain}/20231130/models?compartmentId=${encodeURIComponent(SYNTHETIC_COMPARTMENT_ID)}`,
    );
  });
});

describe('native inference descriptors', () => {
  it.each([
    ['applyGuardrails', '/actions/applyGuardrails'],
    ['chat', '/actions/chat'],
    ['embedText', '/actions/embedText'],
    ['generateText', '/actions/generateText'],
    ['rerankText', '/actions/rerankText'],
    ['summarizeText', '/actions/summarizeText'],
  ] as const)('builds exact JSON-only POST for %s', async (method, path) => {
    const request = await capturedRequest((connector) =>
      connector[method]({ body: SYNTHETIC_ON_DEMAND_BODY }),
    );
    expect(request).toEqual({
      method: 'POST',
      url: `https://inference.generativeai.us-ashburn-1.oci.oraclecloud.com/20231130${path}`,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: SYNTHETIC_ON_DEMAND_BODY,
      signal: expect.any(AbortSignal),
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.headers)).toBe(true);
    expect(Object.isFrozen(request.body)).toBe(true);
    expect(request.headers).not.toHaveProperty('authorization');
    expect(request.headers).not.toHaveProperty('opc-retry-token');
  });

  it('preserves a copied dedicated-serving provider document without normalizing it', async () => {
    const mutable = {
      compartmentId: SYNTHETIC_COMPARTMENT_ID,
      servingMode: {
        servingType: 'DEDICATED',
        endpointId: SYNTHETIC_DEDICATED_BODY.servingMode.endpointId,
      },
      input: 'synthetic input',
    };
    const { connector, transport } = setup();
    const pending = connector.rerankText({ body: mutable });
    mutable.input = 'mutated after invocation';
    await pending;
    expect(transport.mock.calls[0]![0].body).toEqual(SYNTHETIC_DEDICATED_BODY);
    expect(transport.mock.calls[0]![0].body).not.toBe(mutable);
  });

  it('builds ListGuardrailVersions with compartment header and ordered pagination', async () => {
    const request = await capturedRequest((connector) =>
      connector.listGuardrailVersions({
        compartmentId: SYNTHETIC_COMPARTMENT_ID,
        state: 'DEPRECATED',
        limit: 25,
        page: 'synthetic next/page+token',
      }),
    );
    expect(request).toEqual({
      method: 'GET',
      url:
        'https://inference.generativeai.us-ashburn-1.oci.oraclecloud.com/20231130/guardrailVersions' +
        '?state=DEPRECATED&limit=25&page=synthetic%20next%2Fpage%2Btoken',
      headers: {
        accept: 'application/json',
        'opc-compartment-id': SYNTHETIC_COMPARTMENT_ID,
      },
      signal: expect.any(AbortSignal),
    });
    expect(request).not.toHaveProperty('body');
  });
});

describe('read-only discovery and lifecycle descriptors', () => {
  it('lists models with exact ordered filters and one-page pagination', async () => {
    const request = await capturedRequest((connector) =>
      connector.listModels({
        compartmentId: SYNTHETIC_COMPARTMENT_ID,
        capability: 'CHAT',
        lifecycleState: 'ACTIVE',
        limit: 100,
        page: 'synthetic-page',
      }),
    );
    expect(request.method).toBe('GET');
    expect(request.url).toBe(
      'https://generativeai.us-ashburn-1.oci.oraclecloud.com/20231130/models' +
        `?compartmentId=${encodeURIComponent(SYNTHETIC_COMPARTMENT_ID)}` +
        '&capability=CHAT&lifecycleState=ACTIVE&limit=100&page=synthetic-page',
    );
    expect(request.headers).toEqual({ accept: 'application/json' });
  });

  it('lists endpoints and returns copied pagination plus all synthetic lifecycle states', async () => {
    const { connector } = setup(async () =>
      response(SYNTHETIC_ENDPOINT_COLLECTION, {
        'content-type': 'application/json; charset=utf-8',
        'opc-request-id': 'synthetic-request-id',
        'opc-next-page': 'synthetic-next-page',
      }),
    );
    const result = await connector.listEndpoints({
      compartmentId: SYNTHETIC_COMPARTMENT_ID,
      lifecycleState: 'FAILED',
      limit: 6,
      page: 'synthetic-current-page',
    });
    expect(result).toEqual({
      body: SYNTHETIC_ENDPOINT_COLLECTION,
      opcRequestId: 'synthetic-request-id',
      nextPage: 'synthetic-next-page',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.body)).toBe(true);
    expect(Object.isFrozen((result.body as { items: readonly unknown[] }).items)).toBe(true);
  });

  it.each([
    ['getWorkRequest', `/workRequests/${encodeURIComponent(SYNTHETIC_WORK_REQUEST_ID)}`],
    [
      'listWorkRequestErrors',
      `/workRequests/${encodeURIComponent(SYNTHETIC_WORK_REQUEST_ID)}/errors?limit=10&page=synthetic-page`,
    ],
    [
      'listWorkRequestLogs',
      `/workRequests/${encodeURIComponent(SYNTHETIC_WORK_REQUEST_ID)}/logs?limit=10&page=synthetic-page`,
    ],
  ] as const)('builds exact work-request observation for %s', async (method, suffix) => {
    const request = await capturedRequest((connector) => {
      if (method === 'getWorkRequest') {
        return connector.getWorkRequest({ workRequestId: SYNTHETIC_WORK_REQUEST_ID });
      }
      return connector[method]({
        workRequestId: SYNTHETIC_WORK_REQUEST_ID,
        limit: 10,
        page: 'synthetic-page',
      });
    });
    expect(request.url).toBe(
      `https://generativeai.us-ashburn-1.oci.oraclecloud.com/20231130${suffix}`,
    );
    expect(request.headers).toEqual({ accept: 'application/json' });
  });

  it('preserves all current synthetic work-request states immutably', async () => {
    const { connector } = setup(async () => response(SYNTHETIC_WORK_REQUEST));
    const result = await connector.getWorkRequest({
      workRequestId: SYNTHETIC_WORK_REQUEST_ID,
    });
    expect(result.body).toEqual(SYNTHETIC_WORK_REQUEST);
    expect(Object.isFrozen(result.body)).toBe(true);
    expect(Object.isFrozen((result.body as { statuses: readonly string[] }).statuses)).toBe(true);
  });
});

describe('strict records and bounded safe JSON', () => {
  it.each([
    [{ apiVersion: 'latest' }, 'invalid_configuration'],
    [{ region: 'moon-1' }, 'invalid_configuration'],
    [{ timeoutMs: 0 }, 'invalid_configuration'],
    [{ timeoutMs: ORACLE_OCI_GENERATIVE_AI_LIMITS.timeoutMs + 1 }, 'invalid_configuration'],
    [{ extra: true }, 'invalid_configuration'],
  ])('rejects invalid exact configuration %#', (override, code) => {
    expect(() => setup(undefined, override)).toThrow(expectCode(code));
  });

  it('rejects missing and extra connector request keys before transport', async () => {
    const { connector, transport } = setup();
    await expect(connector.chat({} as never)).rejects.toEqual(expectCode('invalid_request'));
    await expect(
      connector.chat({ body: SYNTHETIC_ON_DEMAND_BODY, extra: true } as never),
    ).rejects.toEqual(expectCode('invalid_request'));
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects accessors, symbol keys, dangerous keys, and unexpected prototypes', async () => {
    const { connector, transport } = setup();
    const accessor = Object.defineProperty({}, 'body', {
      enumerable: true,
      get: () => SYNTHETIC_ON_DEMAND_BODY,
    });
    const withSymbol = { body: SYNTHETIC_ON_DEMAND_BODY } as Record<PropertyKey, unknown>;
    withSymbol[Symbol('synthetic')] = true;
    const dangerous = JSON.parse('{"body":{"__proto__":{"polluted":true}}}') as unknown;
    const oddPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
    oddPrototype.body = SYNTHETIC_ON_DEMAND_BODY;

    for (const value of [accessor, withSymbol, dangerous, oddPrototype]) {
      await expect(connector.chat(value as never)).rejects.toEqual(
        expectCode('invalid_request'),
      );
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects cycles, depth, width, array, node, string, and serialized-byte excess', async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index <= ORACLE_OCI_GENERATIVE_AI_LIMITS.jsonDepth; index += 1) {
      deep = { child: deep };
    }
    const wide = Object.fromEntries(
      Array.from(
        { length: ORACLE_OCI_GENERATIVE_AI_LIMITS.recordKeys + 1 },
        (_, index) => [`k${index}`, index],
      ),
    );
    const longString = 'x'.repeat(ORACLE_OCI_GENERATIVE_AI_LIMITS.stringBytes + 1);
    const huge = {
      chunks: Array.from(
        { length: ORACLE_OCI_GENERATIVE_AI_LIMITS.arrayItems },
        () => 'x'.repeat(Math.ceil(ORACLE_OCI_GENERATIVE_AI_LIMITS.totalJsonBytes / 200)),
      ),
    };
    const tooManyNodes = Array.from(
      { length: ORACLE_OCI_GENERATIVE_AI_LIMITS.arrayItems },
      () =>
        Array.from(
          { length: Math.ceil(ORACLE_OCI_GENERATIVE_AI_LIMITS.visitedNodes / 200) },
          () => null,
        ),
    );
    const tooLongArray = Array.from(
      { length: ORACLE_OCI_GENERATIVE_AI_LIMITS.arrayItems + 1 },
      () => null,
    );

    for (const body of [cycle, deep, wide, longString, huge, tooManyNodes, tooLongArray]) {
      const { connector, transport } = setup();
      await expect(connector.chat({ body } as never)).rejects.toEqual(
        expectCode('invalid_request'),
      );
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it.each([
    [{ compartmentId: SYNTHETIC_COMPARTMENT_ID, state: 'UNKNOWN' }, 'invalid_request'],
    [{ compartmentId: SYNTHETIC_COMPARTMENT_ID, limit: 0 }, 'invalid_request'],
    [
      {
        compartmentId: SYNTHETIC_COMPARTMENT_ID,
        page: 'x'.repeat(ORACLE_OCI_GENERATIVE_AI_LIMITS.pageBytes + 1),
      },
      'invalid_request',
    ],
    [{ compartmentId: 'not-an-ocid' }, 'invalid_request'],
    [{ workRequestId: 'not-a-work-request' }, 'invalid_request'],
  ])('rejects invalid filters and identifiers %#', async (request, code) => {
    const { connector, transport } = setup();
    const promise = Object.hasOwn(request, 'workRequestId')
      ? connector.getWorkRequest(request as never)
      : connector.listGuardrailVersions(request as never);
    await expect(promise).rejects.toEqual(expectCode(code));
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('transport response, timeout, redaction, and immutability', () => {
  it('returns a detached deeply frozen response document', async () => {
    const providerBody = {
      nested: { text: 'synthetic result' },
      items: [{ score: 0.5 }],
    };
    const { connector } = setup(async () => response(providerBody));
    const result = await connector.embedText({ body: SYNTHETIC_ON_DEMAND_BODY });
    providerBody.nested.text = 'mutated provider value';
    providerBody.items[0]!.score = 1;
    expect(result.body).toEqual({
      nested: { text: 'synthetic result' },
      items: [{ score: 0.5 }],
    });
    expect(Object.isFrozen(result.body)).toBe(true);
    expect(Object.isFrozen((result.body as { nested: object }).nested)).toBe(true);
    expect(Object.isFrozen((result.body as { items: readonly object[] }).items)).toBe(true);
    expect(Object.isFrozen((result.body as { items: readonly object[] }).items[0])).toBe(true);
  });

  it.each([
    [{ status: 200, headers: {}, body: {} }, 'invalid_response'],
    [
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: {},
      },
      'invalid_response',
    ],
    [
      {
        status: 200,
        headers: { 'content-type': 'application/json', extra: 'x' },
        body: {},
      },
      'invalid_response',
    ],
    [
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Number.NaN,
      },
      'invalid_response',
    ],
    [
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Object.create({ inherited: true }),
      },
      'invalid_response',
    ],
  ])('rejects malformed exact transport response %#', async (raw, code) => {
    const { connector } = setup(async () => raw as OracleOciTransportResponse);
    await expect(connector.chat({ body: SYNTHETIC_ON_DEMAND_BODY })).rejects.toEqual(
      expectCode(code),
    );
  });

  it('times out once, aborts, and never exposes request data', async () => {
    let signal: AbortSignal | undefined;
    const transport = vi.fn<OracleOciAuthorizedTransport>(
      async (request) =>
        new Promise<OracleOciTransportResponse>(() => {
          signal = request.signal;
        }),
    );
    const { connector } = setup(transport, { timeoutMs: 5 });
    const thrown = await connector
      .chat({ body: { secretPrompt: 'must-not-leak' } })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(OracleOciGenerativeAiError);
    expect(thrown).toEqual(expectCode('timeout'));
    expect(String(thrown)).not.toContain('must-not-leak');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
  });

  it('redacts transport causes and OCI provider errors', async () => {
    const transportCause = new Error('synthetic secret cause');
    const transportFailure = setup(async () => {
      throw transportCause;
    }).connector;
    const providerFailure = setup(async () => ({
      status: 429,
      headers: { 'content-type': 'application/json', 'opc-request-id': 'synthetic-id' },
      body: { code: 'TooManyRequests', message: 'synthetic provider secret' },
    })).connector;

    for (const [promise, code] of [
      [transportFailure.chat({ body: SYNTHETIC_ON_DEMAND_BODY }), 'transport_error'],
      [providerFailure.chat({ body: SYNTHETIC_ON_DEMAND_BODY }), 'provider_error'],
    ] as const) {
      const thrown = await promise.catch((error: unknown) => error);
      expect(thrown).toEqual(expectCode(code));
      expect(String(thrown)).not.toMatch(/secret|TooManyRequests|synthetic-id|actions\/chat/);
      expect(thrown).not.toHaveProperty('cause');
      if (code === 'provider_error') expect(thrown).toHaveProperty('status', 429);
    }
  });

  it('does not retry an unexpected status', async () => {
    const { connector, transport } = setup(async () => ({
      status: 302,
      headers: { 'content-type': 'application/json' },
      body: {},
    }));
    await expect(connector.chat({ body: SYNTHETIC_ON_DEMAND_BODY })).rejects.toEqual(
      expectCode('unexpected_response'),
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('static dormant boundary', () => {
  it('contains no network, auth, retry, mutation, compatibility, or registration implementation', () => {
    const sourcePath = fileURLToPath(
      new URL('./oracle-oci-generative-ai.connector.ts', import.meta.url),
    );
    const source = readFileSync(sourcePath, 'utf8');
    for (const forbidden of [
      'fetch(',
      "from 'node:http'",
      "from 'node:https'",
      "from 'node:net'",
      'process.env',
      'Authorization',
      'Bearer ',
      '/openai/v1',
      '/actions/v1',
      'createEndpoint',
      'updateEndpoint',
      'deleteEndpoint',
      'createDedicatedAiCluster',
      'generativeAiAgent',
      'Database23ai',
      'setInterval(',
      'retry(',
      'connectors.module',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DATABRICKS_MOSAIC_AI_MODEL_SERVING_API_VERSION,
  DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS,
  DatabricksMosaicAiModelServingError,
  createDatabricksMosaicAiModelServingConnector,
  type DatabricksMosaicAiAuthorizedTransport,
  type DatabricksMosaicAiTransportRequest,
  type DatabricksMosaicAiTransportResponse,
} from './databricks-mosaic-ai-model-serving.connector';
import {
  SYNTHETIC_ENDPOINT,
  SYNTHETIC_ENDPOINT_LIST,
  SYNTHETIC_ENDPOINT_NAME,
  SYNTHETIC_ENDPOINT_UPDATE_FAILED,
  SYNTHETIC_INVOCATION_REQUEST,
  SYNTHETIC_INVOCATION_RESPONSE,
  SYNTHETIC_OPENAPI_SCHEMA,
  SYNTHETIC_PROVIDER_ERROR,
  SYNTHETIC_WORKSPACE_ORIGINS,
} from './synthetic-fixtures';

const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });

function response(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = JSON_HEADERS,
): DatabricksMosaicAiTransportResponse {
  return { status, headers, body };
}

function setup(
  rawResponse: DatabricksMosaicAiTransportResponse = response(SYNTHETIC_ENDPOINT),
  overrides: Partial<{
    cloud: 'aws' | 'azure' | 'gcp';
    workspaceOrigin: string;
    apiVersion: '2.0';
    timeoutMs: number;
  }> = {},
) {
  const transport = vi.fn<DatabricksMosaicAiAuthorizedTransport>(async () => rawResponse);
  const connector = createDatabricksMosaicAiModelServingConnector({
    cloud: overrides.cloud ?? 'aws',
    workspaceOrigin: overrides.workspaceOrigin ?? SYNTHETIC_WORKSPACE_ORIGINS.aws,
    apiVersion: overrides.apiVersion ?? DATABRICKS_MOSAIC_AI_MODEL_SERVING_API_VERSION,
    timeoutMs: overrides.timeoutMs ?? 1_000,
    transport,
  });
  return { connector, transport };
}

function expectTaskError(
  action: () => unknown,
  code: DatabricksMosaicAiModelServingError['code'],
): void {
  expect(action).toThrowError(
    expect.objectContaining({
      name: 'DatabricksMosaicAiModelServingError',
      code,
    }),
  );
}

async function expectTaskErrorAsync(
  action: Promise<unknown>,
  code: DatabricksMosaicAiModelServingError['code'],
  status?: number,
): Promise<DatabricksMosaicAiModelServingError> {
  const error = await action.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(DatabricksMosaicAiModelServingError);
  expect(error).toMatchObject({ code, ...(status === undefined ? {} : { status }) });
  return error as DatabricksMosaicAiModelServingError;
}

function dataKey(key: string, value: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  Object.defineProperty(record, key, { value, enumerable: true, writable: true });
  return record;
}

describe('Databricks Mosaic AI Model Serving configuration', () => {
  it.each([
    ['aws', SYNTHETIC_WORKSPACE_ORIGINS.aws],
    ['azure', SYNTHETIC_WORKSPACE_ORIGINS.azure],
    ['gcp', SYNTHETIC_WORKSPACE_ORIGINS.gcp],
  ] as const)('keeps the %s cloud label separate from the caller origin', async (cloud, origin) => {
    const { connector, transport } = setup(response(SYNTHETIC_ENDPOINT_LIST), {
      cloud,
      workspaceOrigin: origin,
    });

    await connector.listEndpoints({});

    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0].url).toBe(`${origin}/api/2.0/serving-endpoints`);
  });

  it('requires exact configuration keys and the frozen API version', () => {
    const transport: DatabricksMosaicAiAuthorizedTransport = async () =>
      response(SYNTHETIC_ENDPOINT);
    const valid = {
      cloud: 'aws',
      workspaceOrigin: SYNTHETIC_WORKSPACE_ORIGINS.aws,
      apiVersion: '2.0',
      timeoutMs: 1_000,
      transport,
    } as const;

    expectTaskError(
      () =>
        createDatabricksMosaicAiModelServingConnector({
          ...valid,
          extra: true,
        } as unknown as Parameters<typeof createDatabricksMosaicAiModelServingConnector>[0]),
      'invalid_configuration',
    );
    const { cloud: _cloud, ...withoutCloud } = valid;
    expectTaskError(
      () =>
        createDatabricksMosaicAiModelServingConnector(
          withoutCloud as unknown as Parameters<
            typeof createDatabricksMosaicAiModelServingConnector
          >[0],
        ),
      'invalid_configuration',
    );
    expectTaskError(
      () =>
        createDatabricksMosaicAiModelServingConnector({
          ...valid,
          apiVersion: '2.1',
        } as unknown as Parameters<typeof createDatabricksMosaicAiModelServingConnector>[0]),
      'invalid_configuration',
    );
    expectTaskError(
      () =>
        createDatabricksMosaicAiModelServingConnector({
          ...valid,
          cloud: 'account',
        } as unknown as Parameters<typeof createDatabricksMosaicAiModelServingConnector>[0]),
      'invalid_configuration',
    );
    expectTaskError(
      () =>
        createDatabricksMosaicAiModelServingConnector({
          ...valid,
          transport: 'fetch',
        } as unknown as Parameters<typeof createDatabricksMosaicAiModelServingConnector>[0]),
      'invalid_configuration',
    );
  });

  it.each([0, -1, 1.5, 120_001, Number.POSITIVE_INFINITY])(
    'rejects invalid timeout %s',
    (timeoutMs) => {
      expectTaskError(
        () =>
          createDatabricksMosaicAiModelServingConnector({
            cloud: 'aws',
            workspaceOrigin: SYNTHETIC_WORKSPACE_ORIGINS.aws,
            apiVersion: '2.0',
            timeoutMs,
            transport: async () => response(SYNTHETIC_ENDPOINT),
          }),
        'invalid_configuration',
      );
    },
  );

  it.each([
    'http://synthetic-workspace.cloud.databricks.com',
    'https://user:secret@synthetic-workspace.cloud.databricks.com',
    'https://synthetic-workspace.cloud.databricks.com/workspace',
    'https://synthetic-workspace.cloud.databricks.com?token=synthetic',
    'https://synthetic-workspace.cloud.databricks.com#fragment',
    'https://127.0.0.1',
    'https://[::1]',
    'https://localhost',
    'https://singlelabel',
    'https://synthetic.local',
    'https://synthetic.internal',
    'https://synthetic-id.serving.cloud.databricks.com',
    'https://synthetic-id.shard.serving.azuredatabricks.net',
  ])('rejects unsafe or non-workspace origin %s', (workspaceOrigin) => {
    expectTaskError(
      () =>
        createDatabricksMosaicAiModelServingConnector({
          cloud: 'aws',
          workspaceOrigin,
          apiVersion: '2.0',
          timeoutMs: 1_000,
          transport: async () => response(SYNTHETIC_ENDPOINT),
        }),
      'invalid_configuration',
    );
  });

  it('canonicalizes only a trailing root slash', async () => {
    const { connector, transport } = setup(response(SYNTHETIC_ENDPOINT_LIST), {
      workspaceOrigin: `${SYNTHETIC_WORKSPACE_ORIGINS.aws}/`,
    });
    await connector.listEndpoints({});
    expect(transport.mock.calls[0][0].url).toBe(
      `${SYNTHETIC_WORKSPACE_ORIGINS.aws}/api/2.0/serving-endpoints`,
    );
  });

  it('rejects accessor, symbol, and non-data configuration properties without invoking them', () => {
    const getter = vi.fn(() => 'aws');
    const accessor = {
      workspaceOrigin: SYNTHETIC_WORKSPACE_ORIGINS.aws,
      apiVersion: '2.0',
      timeoutMs: 1_000,
      transport: async () => response(SYNTHETIC_ENDPOINT),
    };
    Object.defineProperty(accessor, 'cloud', { get: getter, enumerable: true });
    expectTaskError(
      () =>
        createDatabricksMosaicAiModelServingConnector(
          accessor as unknown as Parameters<
            typeof createDatabricksMosaicAiModelServingConnector
          >[0],
        ),
      'invalid_configuration',
    );
    expect(getter).not.toHaveBeenCalled();

    const symbolRecord = {
      cloud: 'aws',
      workspaceOrigin: SYNTHETIC_WORKSPACE_ORIGINS.aws,
      apiVersion: '2.0',
      timeoutMs: 1_000,
      transport: async () => response(SYNTHETIC_ENDPOINT),
      [Symbol('synthetic')]: true,
    };
    expectTaskError(
      () =>
        createDatabricksMosaicAiModelServingConnector(
          symbolRecord as unknown as Parameters<
            typeof createDatabricksMosaicAiModelServingConnector
          >[0],
        ),
      'invalid_configuration',
    );
  });
});

describe('Databricks Mosaic AI exact workspace operations', () => {
  it('invokes the native standard-workspace route with exact headers', async () => {
    const { connector, transport } = setup(
      response(SYNTHETIC_INVOCATION_RESPONSE, 200, {
        'content-type': 'application/json; charset=utf-8',
        'served-model-name': 'synthetic-served-entity-v3',
      }),
    );

    const result = await connector.invoke({
      endpointName: SYNTHETIC_ENDPOINT_NAME,
      body: SYNTHETIC_INVOCATION_REQUEST,
    });

    expect(transport).toHaveBeenCalledOnce();
    const descriptor = transport.mock.calls[0][0];
    expect(descriptor).toMatchObject({
      method: 'POST',
      url: `${SYNTHETIC_WORKSPACE_ORIGINS.aws}/serving-endpoints/${SYNTHETIC_ENDPOINT_NAME}/invocations`,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: SYNTHETIC_INVOCATION_REQUEST,
    });
    expect(Object.keys(descriptor).sort()).toEqual(['body', 'headers', 'method', 'signal', 'url']);
    expect(descriptor.headers).not.toHaveProperty('authorization');
    expect(result).toEqual({
      body: SYNTHETIC_INVOCATION_RESPONSE,
      servedModelNameHeader: 'synthetic-served-entity-v3',
    });
  });

  it('lists one unpaginated endpoint collection with no query', async () => {
    const { connector, transport } = setup(response(SYNTHETIC_ENDPOINT_LIST));
    const result = await connector.listEndpoints({});

    expect(transport.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: `${SYNTHETIC_WORKSPACE_ORIGINS.aws}/api/2.0/serving-endpoints`,
      headers: { accept: 'application/json' },
    });
    expect(transport.mock.calls[0][0].url).not.toContain('?');
    expect(transport.mock.calls[0][0]).not.toHaveProperty('body');
    expect(result.body).toEqual(SYNTHETIC_ENDPOINT_LIST);
  });

  it('gets endpoint lifecycle and served-entity documents without normalization', async () => {
    const { connector, transport } = setup(response(SYNTHETIC_ENDPOINT));
    const result = await connector.getEndpoint({ endpointName: SYNTHETIC_ENDPOINT_NAME });

    expect(transport.mock.calls[0][0].url).toBe(
      `${SYNTHETIC_WORKSPACE_ORIGINS.aws}/api/2.0/serving-endpoints/${SYNTHETIC_ENDPOINT_NAME}`,
    );
    expect(result.body).toEqual(SYNTHETIC_ENDPOINT);
    expect(result.body).not.toHaveProperty('normalizedState');
  });

  it('preserves an update-failed lifecycle document without inventing a transition', async () => {
    const { connector } = setup(response(SYNTHETIC_ENDPOINT_UPDATE_FAILED));
    const result = await connector.getEndpoint({ endpointName: 'synthetic-update-failed' });
    expect(result.body).toEqual(SYNTHETIC_ENDPOINT_UPDATE_FAILED);
  });

  it('gets the conditional Preview OpenAPI document on its exact path', async () => {
    const { connector, transport } = setup(response(SYNTHETIC_OPENAPI_SCHEMA));
    const result = await connector.getEndpointOpenApi({ endpointName: SYNTHETIC_ENDPOINT_NAME });

    expect(transport.mock.calls[0][0].url).toBe(
      `${SYNTHETIC_WORKSPACE_ORIGINS.aws}/api/2.0/serving-endpoints/${SYNTHETIC_ENDPOINT_NAME}/openapi`,
    );
    expect(result.body).toEqual(SYNTHETIC_OPENAPI_SCHEMA);
  });

  it('exposes exactly four connector methods', () => {
    const { connector } = setup();
    expect(Object.keys(connector).sort()).toEqual([
      'getEndpoint',
      'getEndpointOpenApi',
      'invoke',
      'listEndpoints',
    ]);
    for (const denied of [
      'createEndpoint',
      'updateEndpoint',
      'startEndpoint',
      'stopEndpoint',
      'deleteEndpoint',
      'paginate',
      'poll',
      'openAi',
    ]) {
      expect(connector).not.toHaveProperty(denied);
    }
  });
});

describe('Databricks Mosaic AI request validation', () => {
  it.each(['', 'a'.repeat(64), 'with space', 'with/slash', 'with.dot', 'é']) (
    'rejects malformed endpoint name %j before transport',
    async (endpointName) => {
      const { connector, transport } = setup();
      await expectTaskErrorAsync(
        connector.getEndpoint({ endpointName }),
        'invalid_request',
      );
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each(['a', '-leading', 'trailing-', '_underscore', 'A-Z_09']) (
    'accepts documented endpoint-name characters in %j',
    async (endpointName) => {
      const { connector, transport } = setup();
      await connector.getEndpoint({ endpointName });
      expect(transport.mock.calls[0][0].url).toContain(`/serving-endpoints/${endpointName}`);
    },
  );

  it('rejects omitted and extra operation keys before transport', async () => {
    const { connector, transport } = setup();
    await expectTaskErrorAsync(
      connector.getEndpoint({} as Parameters<typeof connector.getEndpoint>[0]),
      'invalid_request',
    );
    await expectTaskErrorAsync(
      connector.getEndpoint({
        endpointName: SYNTHETIC_ENDPOINT_NAME,
        version: 1,
      } as unknown as Parameters<typeof connector.getEndpoint>[0]),
      'invalid_request',
    );
    await expectTaskErrorAsync(
      connector.listEndpoints({ pageToken: 'synthetic-page' } as unknown as Parameters<
        typeof connector.listEndpoints
      >[0]),
      'invalid_request',
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects streaming but preserves explicit non-streaming provider data', async () => {
    const { connector, transport } = setup(response(SYNTHETIC_INVOCATION_RESPONSE));
    await expectTaskErrorAsync(
      connector.invoke({ endpointName: SYNTHETIC_ENDPOINT_NAME, body: { stream: true } }),
      'invalid_request',
    );
    expect(transport).not.toHaveBeenCalled();

    await connector.invoke({
      endpointName: SYNTHETIC_ENDPOINT_NAME,
      body: { stream: false, prompt: 'synthetic' },
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('rejects accessor, symbol, custom-prototype, dangerous-key, and cyclic JSON', async () => {
    const { connector, transport } = setup();
    const getter = vi.fn(() => 'synthetic-secret');
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'prompt', { get: getter, enumerable: true });
    const symbolRecord = { prompt: 'synthetic', [Symbol('synthetic')]: true };
    const customPrototype = Object.create({ inherited: true }) as Record<string, unknown>;
    customPrototype.prompt = 'synthetic';
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    for (const body of [
      accessor,
      symbolRecord,
      customPrototype,
      dataKey('__proto__', 'synthetic'),
      dataKey('constructor', 'synthetic'),
      cycle,
    ]) {
      await expectTaskErrorAsync(
        connector.invoke({ endpointName: SYNTHETIC_ENDPOINT_NAME, body }),
        'invalid_request',
      );
    }
    expect(getter).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('enforces depth, record width, array, string, node, total-byte, and finite-number limits', async () => {
    const { connector, transport } = setup();
    let deep: Record<string, unknown> = { value: 'synthetic' };
    for (let index = 0; index <= DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.jsonDepth; index += 1) {
      deep = { child: deep };
    }
    const wide = Object.fromEntries(
      Array.from(
        { length: DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.recordKeys + 1 },
        (_, index) => [`key_${index}`, index],
      ),
    );
    const tooManyNodes = Object.fromEntries(
      Array.from({ length: 128 }, (_, outer) => [
        `branch_${outer}`,
        Array.from({ length: 64 }, (_, inner) => ({ outer, inner })),
      ]),
    );
    const tooManyBytes = Object.fromEntries(
      Array.from({ length: 18 }, (_, index) => [`chunk_${index}`, 'x'.repeat(60_000)]),
    );
    const invalidBodies: unknown[] = [
      deep,
      wide,
      { values: Array.from({ length: DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.arrayItems + 1 }) },
      { text: 'x'.repeat(DATABRICKS_MOSAIC_AI_MODEL_SERVING_LIMITS.stringBytes + 1) },
      tooManyNodes,
      tooManyBytes,
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
    ];

    for (const body of invalidBodies) {
      await expectTaskErrorAsync(
        connector.invoke({
          endpointName: SYNTHETIC_ENDPOINT_NAME,
          body: body as Record<string, unknown>,
        }),
        'invalid_request',
      );
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('copies and freezes request and response graphs without retaining references', async () => {
    const providerBody = { predictions: [{ label: 'before' }] };
    let captured: DatabricksMosaicAiTransportRequest | undefined;
    const transport = vi.fn<DatabricksMosaicAiAuthorizedTransport>(async (request) => {
      captured = request;
      return response(providerBody);
    });
    const connector = createDatabricksMosaicAiModelServingConnector({
      cloud: 'aws',
      workspaceOrigin: SYNTHETIC_WORKSPACE_ORIGINS.aws,
      apiVersion: '2.0',
      timeoutMs: 1_000,
      transport,
    });
    const input = { dataframe_records: [{ feature: 'before' }] };
    const result = await connector.invoke({ endpointName: SYNTHETIC_ENDPOINT_NAME, body: input });

    input.dataframe_records[0].feature = 'after';
    providerBody.predictions[0].label = 'after';
    expect(captured?.body).toEqual({ dataframe_records: [{ feature: 'before' }] });
    expect(result.body).toEqual({ predictions: [{ label: 'before' }] });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured?.headers)).toBe(true);
    expect(Object.isFrozen(captured?.body)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.body)).toBe(true);
    expect(Object.isFrozen((result.body as { predictions: unknown[] }).predictions)).toBe(true);
  });
});

describe('Databricks Mosaic AI response, timeout, and redaction boundary', () => {
  it.each([
    [response(SYNTHETIC_ENDPOINT, 200, {}), 'invalid_response'],
    [response(SYNTHETIC_ENDPOINT, 200, { 'content-type': 'text/plain' }), 'invalid_response'],
    [response(SYNTHETIC_ENDPOINT, 200, { 'content-type': 'application/json', extra: 'x' }), 'invalid_response'],
    [{ status: 200, headers: JSON_HEADERS } as unknown as DatabricksMosaicAiTransportResponse, 'invalid_response'],
    [{ status: 200, headers: JSON_HEADERS, body: {}, extra: true } as unknown as DatabricksMosaicAiTransportResponse, 'invalid_response'],
    [response(SYNTHETIC_ENDPOINT, 99), 'invalid_response'],
    [response(SYNTHETIC_ENDPOINT, 600), 'invalid_response'],
  ] as const)('rejects malformed transport response %#', async (raw, code) => {
    const { connector } = setup(raw);
    await expectTaskErrorAsync(connector.getEndpoint({ endpointName: SYNTHETIC_ENDPOINT_NAME }), code);
  });

  it('accepts served-model-name only for invocation responses', async () => {
    const raw = response(SYNTHETIC_ENDPOINT, 200, {
      'content-type': 'application/json',
      'served-model-name': 'synthetic-served-entity-v3',
    });
    const { connector } = setup(raw);
    await expectTaskErrorAsync(
      connector.getEndpoint({ endpointName: SYNTHETIC_ENDPOINT_NAME }),
      'invalid_response',
    );
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 503])(
    'redacts provider HTTP %s bodies and makes one attempt',
    async (status) => {
      const { connector, transport } = setup(response(SYNTHETIC_PROVIDER_ERROR, status));
      const error = await expectTaskErrorAsync(
        connector.invoke({ endpointName: SYNTHETIC_ENDPOINT_NAME, body: { prompt: 'synthetic' } }),
        'provider_error',
        status,
      );
      expect(error.message).toBe('Databricks Mosaic AI Model Serving rejected the request');
      expect(JSON.stringify(error)).not.toContain('synthetic-secret-marker');
      expect(JSON.stringify(error)).not.toContain('Bearer');
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it.each([201, 204, 301, 302])('maps unexpected HTTP %s without body leakage', async (status) => {
    const { connector } = setup(response(SYNTHETIC_PROVIDER_ERROR, status));
    const error = await expectTaskErrorAsync(
      connector.getEndpoint({ endpointName: SYNTHETIC_ENDPOINT_NAME }),
      'unexpected_response',
      status,
    );
    expect(error.message).toBe('Databricks Mosaic AI Model Serving returned an unexpected status');
    expect(error.message).not.toContain('synthetic');
  });

  it('redacts a transport rejection and never logs it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const transport = vi.fn<DatabricksMosaicAiAuthorizedTransport>(async () => {
      throw new Error('Bearer synthetic-secret-marker at private tenant URL');
    });
    const connector = createDatabricksMosaicAiModelServingConnector({
      cloud: 'aws',
      workspaceOrigin: SYNTHETIC_WORKSPACE_ORIGINS.aws,
      apiVersion: '2.0',
      timeoutMs: 1_000,
      transport,
    });

    const error = await expectTaskErrorAsync(
      connector.listEndpoints({}),
      'transport_error',
    );
    expect(error.message).toBe('Databricks Mosaic AI Model Serving transport failed');
    expect(error.message).not.toContain('Bearer');
    expect(transport).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('aborts deterministically on timeout with exactly one attempt', async () => {
    let capturedSignal: AbortSignal | undefined;
    const transport = vi.fn<DatabricksMosaicAiAuthorizedTransport>(
      (request) =>
        new Promise(() => {
          capturedSignal = request.signal;
        }),
    );
    const connector = createDatabricksMosaicAiModelServingConnector({
      cloud: 'aws',
      workspaceOrigin: SYNTHETIC_WORKSPACE_ORIGINS.aws,
      apiVersion: '2.0',
      timeoutMs: 5,
      transport,
    });

    const error = await expectTaskErrorAsync(connector.listEndpoints({}), 'timeout');
    expect(error.message).toBe('Databricks Mosaic AI Model Serving request timed out');
    expect(transport).toHaveBeenCalledOnce();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe('Databricks Mosaic AI static exclusions and provenance', () => {
  it('contains no built-in network, credential, SDK, mutation, retry, polling, or facade implementation', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'src/connectors/databricks-mosaic-ai-model-serving/databricks-mosaic-ai-model-serving.connector.ts',
      ),
      'utf8',
    );
    for (const banned of [
      /\bfetch\s*\(/,
      /node:https?/,
      /from ['"]https?['"]/,
      /process\.env/,
      /Deno\./,
      /axios/i,
      /Authorization/,
      /Bearer\s/,
      /endpoint_url/,
      /\/openai\//,
      /chat\/completions/,
      /createEndpoint/,
      /updateEndpoint/,
      /deleteEndpoint/,
      /setInterval/,
      /while\s*\(/,
    ]) {
      expect(source).not.toMatch(banned);
    }
  });

  it('records handwritten synthetic provenance and no recorded provider traffic', () => {
    const provenance = readFileSync(
      join(
        process.cwd(),
        'src/connectors/databricks-mosaic-ai-model-serving/fixture-provenance.md',
      ),
      'utf8',
    );
    expect(provenance).toContain('handwritten, deterministic, and fictional');
    expect(provenance).toContain('not recordings, captures, exports, SDK output');
    expect(provenance).toContain('https://docs.databricks.com/api/workspace/servingendpoints/query');
  });
});

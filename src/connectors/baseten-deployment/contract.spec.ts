import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASETEN_DEPLOYMENT_INFERENCE_CONTRACT,
  BASETEN_DEPLOYMENT_LIMITS,
  buildBasetenDeploymentRequest,
  classifyBasetenDeploymentFailure,
  parseBasetenDeploymentAsyncSubmitResponse,
  parseBasetenDeploymentSyncResponse,
} from './contract';

const fixturesDirectory = join(__dirname, '__fixtures__');

function loadJsonFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixturesDirectory, name), 'utf8')) as Record<string, unknown>;
}

function validSyncRequest(): Record<string, unknown> {
  return loadJsonFixture('sync-request.valid.json');
}

function validAsyncRequest(): Record<string, unknown> {
  return loadJsonFixture('async-request.valid.json');
}

function validSyncResponse(): Record<string, unknown> {
  return loadJsonFixture('sync-response.valid.json');
}

function validAsyncResponse(): Record<string, unknown> {
  return loadJsonFixture('async-response.valid.json');
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
  expect(action).toThrowError('BASETEN_DEPLOYMENT_INVALID_INPUT');
}

describe('Baseten deployment contract metadata', () => {
  it('freezes the dedicated deployment inference identity without hosted Model APIs', () => {
    expect(BASETEN_DEPLOYMENT_INFERENCE_CONTRACT).toStrictEqual({
      provider: 'baseten-deployment',
      service: 'baseten-dedicated-model-deployment-inference',
      apiVersion: 'inference-v1',
      operations: ['deployment.predict.sync', 'deployment.predict.async_submit'],
      resourceKind: 'model',
      authorizationSchemes: ['Bearer', 'Api-Key'],
      authorizationOwner: 'caller',
      retryCount: 0,
    });
    expectDeepFrozen(BASETEN_DEPLOYMENT_INFERENCE_CONTRACT);
    expect(JSON.stringify(BASETEN_DEPLOYMENT_INFERENCE_CONTRACT)).not.toMatch(
      /inference\.baseten\.co|management|chain-|run_remote|wake|status/i,
    );
  });

  it('freezes every local implementation limit', () => {
    expect(BASETEN_DEPLOYMENT_LIMITS).toStrictEqual({
      maxDepth: 8,
      maxKeysPerObject: 32,
      maxArrayLength: 128,
      maxStringBytes: 262_144,
      maxAggregateInputBytes: 1_048_576,
      maxAsyncSerializedBodyBytes: 262_144,
      maxResponseBytes: 4_194_304,
    });
    expectDeepFrozen(BASETEN_DEPLOYMENT_LIMITS);
  });
});

describe('buildBasetenDeploymentRequest', () => {
  it('builds the sync production descriptor from the synthetic fixture', () => {
    const descriptor = buildBasetenDeploymentRequest(validSyncRequest());

    expect(descriptor).toStrictEqual({
      provider: 'baseten-deployment',
      method: 'POST',
      url: 'https://model-7wz2p0q.api.baseten.co/production/predict',
      headers: {
        'Content-Type': 'application/json',
      },
      authorization: {
        scheme: 'Bearer',
        owner: 'caller',
      },
      retryCount: 0,
      body: {
        prompt: 'Synthetic deterministic predict input.',
      },
    });
    expectDeepFrozen(descriptor);
    expect(JSON.stringify(descriptor)).not.toMatch(/token|api[_-]?key|authorization":"/i);
  });

  it('builds async submit with optional envelope fields', () => {
    const descriptor = buildBasetenDeploymentRequest(validAsyncRequest());

    expect(descriptor.url).toBe('https://model-7wz2p0q.api.baseten.co/production/async_predict');
    expect(descriptor.authorization.scheme).toBe('Api-Key');
    expect(descriptor.body).toStrictEqual({
      model_input: {
        prompt: 'Synthetic deterministic async input.',
      },
      priority: 0,
      max_time_in_queue_seconds: 600,
    });
    expectDeepFrozen(descriptor);
  });

  it.each([
    ['non_regional environment', {
      ...validSyncRequest(),
      target: { kind: 'environment', name: 'staging' },
    }, 'https://model-7wz2p0q.api.baseten.co/environments/staging/predict'],
    ['non_regional deployment', {
      ...validSyncRequest(),
      target: { kind: 'deployment', deploymentId: 'dep123' },
    }, 'https://model-7wz2p0q.api.baseten.co/deployment/dep123/predict'],
    ['non_regional development', {
      ...validSyncRequest(),
      target: { kind: 'development' },
    }, 'https://model-7wz2p0q.api.baseten.co/development/predict'],
    ['regional bare predict', {
      ...validSyncRequest(),
      hostingMode: 'regional',
      target: { kind: 'regional', environmentName: 'eu-west' },
    }, 'https://model-7wz2p0q-eu-west.api.baseten.co/predict'],
  ])('builds template URLs for %s', (_label, input, expectedUrl) => {
    expect(buildBasetenDeploymentRequest(input).url).toBe(expectedUrl);
  });

  it('copies input before freezing so caller mutation cannot alter output', () => {
    const input = validSyncRequest();
    const descriptor = buildBasetenDeploymentRequest(input);
    const payload = input.payload as Record<string, unknown>;
    payload.prompt = 'mutated';
    expect(descriptor.body.prompt).toBe('Synthetic deterministic predict input.');
  });

  it('rejects arbitrary URLs, hosted Model APIs, chains, and extra fields', () => {
    expectInvalid(() =>
      buildBasetenDeploymentRequest({
        ...validSyncRequest(),
        baseUrl: 'https://inference.baseten.co/v1/chat/completions',
      }),
    );
    expectInvalid(() =>
      buildBasetenDeploymentRequest({
        ...validSyncRequest(),
        chainId: 'chain-abc',
      }),
    );
    expectInvalid(() =>
      buildBasetenDeploymentRequest({
        ...validSyncRequest(),
        operation: 'deployment.run_remote.sync',
      }),
    );
  });

  it.each([
    ['public HTTPS', 'https://api.example.com/callback'],
    ['loopback', 'http://127.0.0.1:8080/hook'],
    ['link-local', 'http://169.254.169.254/latest/meta-data'],
  ])('rejects top-level webhook_endpoint (%s)', (_label, webhookEndpoint) => {
    expectInvalid(() =>
      buildBasetenDeploymentRequest({
        ...validAsyncRequest(),
        webhook_endpoint: webhookEndpoint,
      }),
    );
  });

  function serializedAsyncBodyBytesForPrompt(prompt: string): number {
    const body = {
      model_input: { prompt },
      priority: 0,
      max_time_in_queue_seconds: 600,
    };
    return Buffer.byteLength(JSON.stringify(body), 'utf8');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function asyncBodyUtf8Bytes(modelInput: Record<string, unknown>): number {
    const descriptor = buildBasetenDeploymentRequest({
      ...validAsyncRequest(),
      model_input: modelInput,
    });
    return Buffer.byteLength(JSON.stringify(descriptor.body), 'utf8');
  }

  function modelInputPromptForBodyBytes(targetBytes: number): string {
    let low = 0;
    let high = BASETEN_DEPLOYMENT_LIMITS.maxStringBytes;
    let best = '';
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const prompt = 'x'.repeat(mid);
      const bytes = serializedAsyncBodyBytesForPrompt(prompt);
      if (bytes <= targetBytes) {
        best = prompt;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  it('accepts an emitted async JSON body of exactly 262144 UTF-8 bytes', () => {
    const prompt = modelInputPromptForBodyBytes(262_144);
    const descriptor = buildBasetenDeploymentRequest({
      ...validAsyncRequest(),
      model_input: { prompt },
    });
    const bytes = Buffer.byteLength(JSON.stringify(descriptor.body), 'utf8');
    expect(bytes).toBe(262_144);
  });

  it('rejects an emitted async JSON body of 262145 UTF-8 bytes', () => {
    const prompt = modelInputPromptForBodyBytes(262_145);
    expect(serializedAsyncBodyBytesForPrompt(prompt)).toBe(262_145);
    expectInvalid(() =>
      buildBasetenDeploymentRequest({
        ...validAsyncRequest(),
        model_input: { prompt },
      }),
    );
  });

  it('measures async payload limits using UTF-8 bytes rather than JavaScript string length', () => {
    const asciiPrompt = modelInputPromptForBodyBytes(262_141);
    const multibytePrompt = `${asciiPrompt}\u{1F642}`;
    expect(multibytePrompt.length).toBeLessThan(
      Buffer.byteLength(multibytePrompt, 'utf8'),
    );
    expect(serializedAsyncBodyBytesForPrompt(multibytePrompt)).toBe(262_145);
    expectInvalid(() =>
      buildBasetenDeploymentRequest({
        ...validAsyncRequest(),
        model_input: { prompt: multibytePrompt },
      }),
    );
  });

  it.each([10, 259_200])('accepts max_time_in_queue_seconds=%i', (value) => {
    const descriptor = buildBasetenDeploymentRequest({
      ...validAsyncRequest(),
      max_time_in_queue_seconds: value,
    });
    expect(descriptor.body.max_time_in_queue_seconds).toBe(value);
  });

  it.each([9, 259_201, 10.5])('rejects max_time_in_queue_seconds=%s', (value) => {
    expectInvalid(() =>
      buildBasetenDeploymentRequest({
        ...validAsyncRequest(),
        max_time_in_queue_seconds: value,
      }),
    );
  });

  it('rejects accessors, pollution keys, cycles, and oversized values', () => {
    expectInvalid(() =>
      buildBasetenDeploymentRequest({
        ...validSyncRequest(),
        payload: Object.defineProperty({ prompt: 'x' }, 'prompt', {
          get() {
            return 'accessor';
          },
        }),
      }),
    );
    expectInvalid(() =>
      buildBasetenDeploymentRequest({
        ...validSyncRequest(),
        payload: JSON.parse('{"__proto__":{"polluted":true},"prompt":"x"}'),
      }),
    );
    const cyclic: Record<string, unknown> = { prompt: 'x' };
    cyclic.self = cyclic;
    expectInvalid(() =>
      buildBasetenDeploymentRequest({
        ...validSyncRequest(),
        payload: cyclic,
      }),
    );
  });
});

describe('parseBasetenDeploymentSyncResponse', () => {
  it('normalizes opaque sync output from the synthetic fixture', () => {
    const parsed = parseBasetenDeploymentSyncResponse(validSyncResponse());
    expect(parsed).toStrictEqual({
      result: 'Synthetic deterministic predict output.',
      latency_ms: 42,
    });
    expectDeepFrozen(parsed);
  });
});

describe('parseBasetenDeploymentAsyncSubmitResponse', () => {
  it('normalizes async submit acknowledgement from the synthetic fixture', () => {
    const parsed = parseBasetenDeploymentAsyncSubmitResponse(validAsyncResponse());
    expect(parsed).toStrictEqual({
      request_id: '9876543210abcdef1234567890fedcba',
    });
    expectDeepFrozen(parsed);
  });

  it('rejects extra acknowledgement fields', () => {
    expectInvalid(() =>
      parseBasetenDeploymentAsyncSubmitResponse({
        request_id: 'abc',
        status: 'QUEUED',
      }),
    );
  });
});

describe('classifyBasetenDeploymentFailure', () => {
  it.each([
    [401, 'unauthorized'],
    [413, 'payload_too_large'],
    [422, 'invalid_request'],
    [429, 'rate_limited'],
    [500, 'internal_error'],
    [502, 'bad_gateway'],
    [503, 'unavailable'],
    [504, 'gateway_timeout'],
    [418, 'upstream_error'],
  ])('maps HTTP %i to %s with retry false', (status, code) => {
    expect(classifyBasetenDeploymentFailure({ kind: 'http', status })).toStrictEqual({
      provider: 'baseten-deployment',
      code,
      status,
      retry: false,
    });
  });

  it('maps timeout without status and rejects redaction leaks', () => {
    expect(classifyBasetenDeploymentFailure({ kind: 'timeout' })).toStrictEqual({
      provider: 'baseten-deployment',
      code: 'timeout',
      retry: false,
    });
    expectInvalid(() =>
      classifyBasetenDeploymentFailure({
        kind: 'http',
        status: 401,
        body: 'secret',
      }),
    );
  });
});

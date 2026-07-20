/**
 * Fixture replay tests for image-generation connectors.
 * CONN-0052 Phase 2 prep — Path C (all Vault creds still PLACEHOLDER).
 *
 * These tests use synthetic JSON fixtures (matching real provider response shapes)
 * to verify connector error handling without live API calls.
 *
 * Per memory `feedback_mock_tests_hide_api_drift`: fixtures are crafted to match
 * the exact response shapes documented in INSIGHTS-CONN-0052.md § Documentation References.
 * When real creds land (Phase 2 full), replace MSW handlers with `http.passthrough()` and
 * capture live responses into `test/fixtures/image-generation/`.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { VertexImageConnector } from './vertex/vertex-image.connector';
import { ReplicateFluxConnector } from './replicate/replicate-flux.connector';
import { OpenAIImagesConnector } from './openai-images/openai-images.connector';
import { CircuitBreakerManager } from '../../core/resilience/circuit-breaker-manager';

const TEST_PRIVATE_KEY = ['synthetic', 'vertex', 'test', 'material'].join('-');

// ─── Mock google-auth-library (no real SA needed for unit/fixture tests) ───────
vi.mock('google-auth-library', () => {
  const MockGoogleAuth = vi.fn().mockImplementation(function (this: {
    getAccessToken: ReturnType<typeof vi.fn>;
  }) {
    this.getAccessToken = vi.fn().mockResolvedValue({ token: 'fixture-test-token' });
  });
  return { GoogleAuth: MockGoogleAuth };
});

// ─── Mock replicate npm package ───────────────────────────────────────────────
vi.mock('replicate', () => {
  const MockReplicate = vi.fn().mockImplementation(function (this: {
    predictions: { create: ReturnType<typeof vi.fn> };
    auth: string;
  }) {
    this.predictions = { create: vi.fn() };
    this.auth = 'fixture-replicate-token';
  });
  return { default: MockReplicate };
});

// ─── Mock openai package ──────────────────────────────────────────────────────
vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(function (this: {
    images: { generate: ReturnType<typeof vi.fn> };
    apiKey: string;
  }) {
    this.images = { generate: vi.fn() };
    this.apiKey = 'fixture-openai-key';
  });
  return { default: MockOpenAI };
});

// ─── Fixture loader ───────────────────────────────────────────────────────────

// __dirname = code/src/connectors/image-generation
// ../../.. = code/  →  then test/fixtures/image-generation
const FIXTURE_DIR = resolve(__dirname, '../../..', 'test/fixtures/image-generation');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8'));
}

// ─── MSW server ───────────────────────────────────────────────────────────────

const VERTEX_BASE = 'https://us-central1-aiplatform.googleapis.com';
const REPLICATE_API = 'https://api.replicate.com';
const OPENAI_API = 'https://api.openai.com';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ─── Shared request fixtures ──────────────────────────────────────────────────

const vertexReq = {
  tier: 'mid' as const,
  prompt: 'a red cube on white background',
  quality: 'medium' as const,
  count: 1,
  outputFormat: 'url' as const,
  outputAsync: 'auto' as const,
};

const replicateReq = {
  tier: 'premium' as const,
  prompt: 'a red cube on white background',
  quality: 'high' as const,
  count: 1,
  outputFormat: 'url' as const,
  outputAsync: 'auto' as const,
};

const openaiReq = {
  tier: 'premium' as const,
  prompt: 'a red cube on white background',
  quality: 'high' as const,
  count: 1,
  outputFormat: 'url' as const,
  outputAsync: 'auto' as const,
};

// ─── Vertex AI fixture replay ─────────────────────────────────────────────────

describe('Vertex AI connector — fixture replay', () => {
  let connector: VertexImageConnector;

  beforeAll(() => {
    const cbManager = new CircuitBreakerManager('vertex-fixture', 5, 30_000);
    connector = new VertexImageConnector(
      'test-project',
      'us-central1',
      JSON.stringify({
        type: 'service_account',
        project_id: 'test-project',
        client_email: 'fixture@test.iam.gserviceaccount.com',
        private_key: TEST_PRIVATE_KEY,
      }),
      cbManager,
    );
  });

  it('happy-path: fixture shape matches predictions array', async () => {
    const fixture = loadFixture('vertex-imagen4-fast-success.json');

    server.use(
      http.post(
        `${VERTEX_BASE}/v1/projects/test-project/locations/us-central1/publishers/google/models/imagen-4.0-fast-generate-001:predict`,
        () => HttpResponse.json(fixture),
      ),
    );

    const result = await connector.generate(vertexReq);

    expect(result.status).toBe('completed');
    expect(result.routing.chosenProvider).toBe('vertex');
    expect(result.costUsd).toBeGreaterThan(0);
    // Fixture has 1 prediction → 1 URL
    expect(result.urls).toHaveLength(1);
  });

  it('quota-exceeded (429): connector throws with Vertex API error message', async () => {
    const fixture = loadFixture('vertex-imagen4-fast-quota-exceeded.json');
    // Fresh connector per error test — avoid CB open state bleeding between tests
    const cbFresh = new CircuitBreakerManager('vertex-fixture-429', 5, 30_000);
    const freshConnector = new VertexImageConnector(
      'test-project',
      'us-central1',
      JSON.stringify({
        type: 'service_account',
        project_id: 'test-project',
        client_email: 'fixture@test.iam.gserviceaccount.com',
        private_key: TEST_PRIVATE_KEY,
      }),
      cbFresh,
    );

    server.use(
      http.post(
        `${VERTEX_BASE}/v1/projects/test-project/locations/us-central1/publishers/google/models/imagen-4.0-fast-generate-001:predict`,
        () => HttpResponse.json(fixture, { status: 429 }),
      ),
    );

    await expect(freshConnector.generate(vertexReq)).rejects.toThrow(/429/);
  });

  it('auth-failure (401): connector throws with Vertex API error message', async () => {
    const fixture = loadFixture('vertex-auth-error.json');
    const cbFresh = new CircuitBreakerManager('vertex-fixture-401', 5, 30_000);
    const freshConnector = new VertexImageConnector(
      'test-project',
      'us-central1',
      JSON.stringify({
        type: 'service_account',
        project_id: 'test-project',
        client_email: 'fixture@test.iam.gserviceaccount.com',
        private_key: TEST_PRIVATE_KEY,
      }),
      cbFresh,
    );

    server.use(
      http.post(
        `${VERTEX_BASE}/v1/projects/test-project/locations/us-central1/publishers/google/models/imagen-4.0-fast-generate-001:predict`,
        () => HttpResponse.json(fixture, { status: 401 }),
      ),
    );

    await expect(freshConnector.generate(vertexReq)).rejects.toThrow(/401/);
  });

  it('server-error (503): connector throws with Vertex API error message', async () => {
    const fixture = loadFixture('vertex-server-error.json');
    const cbFresh = new CircuitBreakerManager('vertex-fixture-503', 5, 30_000);
    const freshConnector = new VertexImageConnector(
      'test-project',
      'us-central1',
      JSON.stringify({
        type: 'service_account',
        project_id: 'test-project',
        client_email: 'fixture@test.iam.gserviceaccount.com',
        private_key: TEST_PRIVATE_KEY,
      }),
      cbFresh,
    );

    server.use(
      http.post(
        `${VERTEX_BASE}/v1/projects/test-project/locations/us-central1/publishers/google/models/imagen-4.0-fast-generate-001:predict`,
        () => HttpResponse.json(fixture, { status: 503 }),
      ),
    );

    await expect(freshConnector.generate(vertexReq)).rejects.toThrow(/503/);
  });

  it('fixture shape is valid JSON with predictions array', () => {
    const fixture = loadFixture('vertex-imagen4-fast-success.json') as {
      predictions: Array<{ bytesBase64Encoded: string; mimeType: string }>;
    };

    expect(Array.isArray(fixture.predictions)).toBe(true);
    expect(fixture.predictions.length).toBeGreaterThan(0);
    expect(typeof fixture.predictions[0].bytesBase64Encoded).toBe('string');
    expect(fixture.predictions[0].mimeType).toMatch(/^image\//);
  });
});

// ─── Replicate FLUX fixture replay ───────────────────────────────────────────

describe('Replicate FLUX connector — fixture replay', () => {
  let connector: ReplicateFluxConnector;

  beforeAll(() => {
    const cbManager = new CircuitBreakerManager('replicate-fixture', 5, 30_000);
    connector = new ReplicateFluxConnector('r8_fixture_token_abc', cbManager);
  });

  it('happy-path: fixture shape matches succeeded prediction with output URLs', async () => {
    const fixture = loadFixture('replicate-flux-pro-success.json');

    server.use(
      http.post(`${REPLICATE_API}/v1/models/black-forest-labs/flux-pro/predictions`, () =>
        HttpResponse.json(fixture),
      ),
    );

    const result = await connector.generate(replicateReq);

    expect(result.status).toBe('completed');
    expect(result.routing.chosenProvider).toBe('replicate');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.urls).toHaveLength(1);
  });

  it('polling-started (async) fixture has status "starting" and no output', () => {
    const fixture = loadFixture('replicate-flux-pro-polling-started.json') as {
      status: string;
      output: null;
      urls: { get: string };
    };

    expect(fixture.status).toBe('starting');
    expect(fixture.output).toBeNull();
    expect(typeof fixture.urls.get).toBe('string');
    expect(fixture.urls.get).toContain('/v1/predictions/');
  });

  it('failed-prediction fixture has status "failed" and error message', () => {
    const fixture = loadFixture('replicate-flux-pro-error.json') as {
      status: string;
      error: string;
      output: null;
    };

    expect(fixture.status).toBe('failed');
    expect(typeof fixture.error).toBe('string');
    expect(fixture.output).toBeNull();
  });

  it('unauthorized (401): connector throws on HTTP 401', async () => {
    const fixture = loadFixture('replicate-unauthorized.json');

    server.use(
      http.post(`${REPLICATE_API}/v1/models/black-forest-labs/flux-pro/predictions`, () =>
        HttpResponse.json(fixture, { status: 401 }),
      ),
    );

    await expect(connector.generate(replicateReq)).rejects.toThrow(/401/);
  });

  it('server-error (500): connector throws on HTTP 500', async () => {
    server.use(
      http.post(`${REPLICATE_API}/v1/models/black-forest-labs/flux-pro/predictions`, () =>
        HttpResponse.json({ detail: 'Internal Server Error' }, { status: 500 }),
      ),
    );

    await expect(connector.generate(replicateReq)).rejects.toThrow(/500/);
  });
});

// ─── OpenAI Images fixture replay ─────────────────────────────────────────────

describe('OpenAI Images connector — fixture replay', () => {
  let connector: OpenAIImagesConnector;

  beforeAll(() => {
    const cbManager = new CircuitBreakerManager('openai-images-fixture', 5, 30_000);
    connector = new OpenAIImagesConnector('sk-proj-fixture-key-abc', cbManager);
  });

  it('happy-path URL format: fixture shape has data[].url', async () => {
    const fixture = loadFixture('openai-gpt-image-1-success-url.json');

    server.use(http.post(`${OPENAI_API}/v1/images/generations`, () => HttpResponse.json(fixture)));

    const result = await connector.generate(openaiReq);

    expect(result.status).toBe('completed');
    expect(result.routing.chosenProvider).toBe('openai-images');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.urls.length).toBeGreaterThan(0);
  });

  it('b64_json fixture shape has data[].b64_json field (no url)', () => {
    const fixture = loadFixture('openai-gpt-image-1-success-b64.json') as {
      data: Array<{ b64_json: string; revised_prompt?: string }>;
    };

    expect(Array.isArray(fixture.data)).toBe(true);
    expect(fixture.data.length).toBeGreaterThan(0);
    expect(typeof fixture.data[0].b64_json).toBe('string');
    expect('url' in fixture.data[0]).toBe(false);
  });

  it('content-policy-violation (400): fixture shape has error.code = content_policy_violation', () => {
    const fixture = loadFixture('openai-gpt-image-1-error-moderation.json') as {
      error: { code: string; type: string };
    };

    expect(fixture.error.code).toBe('content_policy_violation');
    expect(fixture.error.type).toBe('invalid_request_error');
  });

  it('content-policy-violation: connector throws on HTTP 400', async () => {
    const fixture = loadFixture('openai-gpt-image-1-error-moderation.json');

    server.use(
      http.post(`${OPENAI_API}/v1/images/generations`, () =>
        HttpResponse.json(fixture, { status: 400 }),
      ),
    );

    await expect(connector.generate(openaiReq)).rejects.toThrow(/400/);
  });

  it('unauthorized (401): connector throws on HTTP 401', async () => {
    const fixture = loadFixture('openai-unauthorized.json');

    server.use(
      http.post(`${OPENAI_API}/v1/images/generations`, () =>
        HttpResponse.json(fixture, { status: 401 }),
      ),
    );

    await expect(connector.generate(openaiReq)).rejects.toThrow(/401/);
  });

  it('server-error (500): connector throws on HTTP 500', async () => {
    server.use(
      http.post(`${OPENAI_API}/v1/images/generations`, () =>
        HttpResponse.json({ error: { message: 'Internal Server Error' } }, { status: 500 }),
      ),
    );

    await expect(connector.generate(openaiReq)).rejects.toThrow(/500/);
  });
});

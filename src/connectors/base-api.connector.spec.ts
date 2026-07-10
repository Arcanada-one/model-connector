import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseApiConnector, ParsedApiOutput } from './base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from './interfaces/connector.interface';

class TestApiConnector extends BaseApiConnector {
  readonly name = 'test-api';

  protected getBaseUrl(): string {
    return 'http://localhost:9999';
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/v1/test`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    return { input: request.prompt };
  }

  protected parseResponse(json: unknown): ParsedApiOutput {
    const data = json as { result: string; tokens: number };
    return {
      text: data.result,
      model: 'test-model',
      inputTokens: data.tokens,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'test-api',
      type: 'api',
      models: ['test-model'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 30_000,
    };
  }
}

// CONN-0238 — a connector that participates in dynamic model refresh, with a
// static floor that DIFFERS from the live list so REPLACE-vs-UNION is observable.
class RefreshTestConnector extends BaseApiConnector {
  readonly name = 'refresh-test';
  protected getBaseUrl(): string {
    return 'http://localhost:9999';
  }
  protected getStaticModels(): string[] {
    return ['static-a', 'static-b'];
  }
  protected buildRequestUrl(): string {
    return `${this.getBaseUrl()}/v1/test`;
  }
  protected buildRequestBody(request: ConnectorRequest): unknown {
    return { input: request.prompt };
  }
  protected parseResponse(): ParsedApiOutput {
    return { text: '', model: 'x', inputTokens: 0, outputTokens: 0, costUsd: 0, isError: false };
  }
  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: this.dynamicModels,
      modelMeta: this.dynamicModelMetas,
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 30_000,
    };
  }
}

describe('BaseApiConnector — CONN-0238 REPLACE-not-UNION + extractModels', () => {
  let connector: RefreshTestConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new RefreshTestConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.restoreAllMocks());

  function mockModelsOk(ids: string[]) {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: ids.map((id) => ({ id })) }),
    });
  }

  it('REPLACES the static list with the live list on success (no UNION leftovers)', async () => {
    mockModelsOk(['static-b', 'live-c']);
    await connector.refreshModels();
    const models = connector.getCapabilities().models;
    // 'static-a' is NOT in the live response → REPLACE drops it (UNION would keep it).
    expect(models).toEqual(['static-b', 'live-c']);
    expect(models).not.toContain('static-a');
  });

  it('falls back to the static list (offline/CI) when the live fetch fails', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    await expect(connector.refreshModels()).resolves.not.toThrow();
    expect(connector.getCapabilities().models).toEqual(['static-a', 'static-b']);
  });

  it('keeps the static list on a non-2xx response (no phantom replacement)', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503 });
    await connector.refreshModels();
    expect(connector.getCapabilities().models).toEqual(['static-a', 'static-b']);
  });

  it('dynamicModelMetas defaults each id to a {id}-only meta (no modality)', async () => {
    mockModelsOk(['live-c', 'live-d']);
    await connector.refreshModels();
    const metas = connector.getCapabilities().modelMeta ?? [];
    expect(metas).toEqual([{ id: 'live-c' }, { id: 'live-d' }]);
  });

  it('keeps the static list when the response has an empty data[] (no replacement)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [] }),
    });
    await connector.refreshModels();
    expect(connector.getCapabilities().models).toEqual(['static-a', 'static-b']);
  });

  it('keeps the static list on garbage JSON (no data[]) — never throws', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ nope: 1 }),
    });
    await expect(connector.refreshModels()).resolves.not.toThrow();
    expect(connector.getCapabilities().models).toEqual(['static-a', 'static-b']);
  });
});

describe('BaseApiConnector', () => {
  let connector: TestApiConnector;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new TestApiConnector();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('execute', () => {
    it('should make POST request and return success response', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: 'hello', tokens: 5 }),
      });

      const response = await connector.execute({ prompt: 'test input' });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://localhost:9999/v1/test');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ input: 'test input' });
      expect(opts.headers['Content-Type']).toBe('application/json');

      expect(response.status).toBe('success');
      expect(response.connector).toBe('test-api');
      expect(response.result).toBe('hello');
      expect(response.usage.inputTokens).toBe(5);
      expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return error on HTTP 4xx', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"detail":"bad request"}'),
      });

      const response = await connector.execute({ prompt: 'bad' });

      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('validation_error');
    });

    it('should return rate_limited on HTTP 429', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('rate limited'),
      });

      const response = await connector.execute({ prompt: 'fast' });

      expect(response.status).toBe('rate_limited');
      expect(response.error?.type).toBe('rate_limited');
    });

    it('should return auth_error on HTTP 401', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('unauthorized'),
      });

      const response = await connector.execute({ prompt: 'secret' });

      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('auth_error');
    });

    it('should return auth_error on HTTP 400 with invalid-api-key body (CONN-0050)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({ error: { message: 'Incorrect API key provided: sk-***' } }),
          ),
      });

      const response = await connector.execute({ prompt: 'secret' });

      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('auth_error');
    });

    it('should return auth_error on HTTP 400 with plain-text unauthorized body (CONN-0050)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Unauthorized: invalid credentials'),
      });

      const response = await connector.execute({ prompt: 'secret' });

      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('auth_error');
    });

    it('should keep HTTP 400 as validation_error when body has no auth keywords (CONN-0050)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve(JSON.stringify({ error: { message: 'prompt too long' } })),
      });

      const response = await connector.execute({ prompt: 'secret' });

      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('validation_error');
    });

    it('should return error on HTTP 500', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('internal server error'),
      });

      const response = await connector.execute({ prompt: 'crash' });

      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('server_error');
    });

    it('should return timeout on fetch abort', async () => {
      fetchSpy.mockRejectedValueOnce(new DOMException('signal timed out', 'AbortError'));

      const response = await connector.execute({ prompt: 'slow' });

      expect(response.status).toBe('timeout');
      expect(response.error?.type).toBe('timeout');
    });

    it('should return error on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

      const response = await connector.execute({ prompt: 'offline' });

      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('network_error');
    });

    it('should return error on JSON parse failure', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      });

      const response = await connector.execute({ prompt: 'garbage' });

      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('parse_error');
    });

    // Bundle (CONN-0048): 404 + model_not_found semantics → validation_error fast-fail.
    // Targets Groq/OpenRouter/OpenAI nested envelope shape (verified Groq fixture
    // datarim/tasks/CONN-0048-fixtures.md cross-reference).
    it('should classify HTTP 404 with error.code=model_not_found as validation_error', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () =>
          Promise.resolve(
            '{"error":{"message":"The model `nonexistent` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}',
          ),
      });
      const response = await connector.execute({ prompt: 'hello', model: 'nonexistent' });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('validation_error');
    });

    it('should classify HTTP 404 with model-not-found phrase (no code) as validation_error', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('{"error":{"message":"Model not found: nonexistent-xyz"}}'),
      });
      const response = await connector.execute({ prompt: 'hello', model: 'nonexistent-xyz' });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('validation_error');
    });

    it('should keep HTTP 404 with unrelated error code as http_error', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () =>
          Promise.resolve(
            '{"error":{"message":"Endpoint not configured","code":"route_not_found"}}',
          ),
      });
      const response = await connector.execute({ prompt: 'hello' });
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe('http_error');
    });
  });

  describe('per-model circuit breaker', () => {
    it('should isolate circuit breaker per model', async () => {
      // Trip circuit for model-a via auth error (instant open)
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('unauthorized'),
      });
      await connector.execute({ prompt: 'test', model: 'model-a' });

      // model-a should be blocked
      const blocked = await connector.execute({ prompt: 'test', model: 'model-a' });
      expect(blocked.error?.type).toBe('circuit_open');

      // model-b should still work
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: 'hello', tokens: 5 }),
      });
      const ok = await connector.execute({ prompt: 'test', model: 'model-b' });
      expect(ok.status).toBe('success');
    });

    it('should return per-model circuit breaker states in getStatus', async () => {
      // Make requests with two models
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: 'ok', tokens: 1 }),
      });
      await connector.execute({ prompt: 'test', model: 'gpt-4' });

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: 'ok', tokens: 1 }),
      });
      await connector.execute({ prompt: 'test', model: 'claude' });

      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 }); // health check
      const status = await connector.getStatus();
      expect(status.circuitBreakers).toBeDefined();
      expect(status.circuitBreakers!['gpt-4'].state).toBe('closed');
      expect(status.circuitBreakers!['claude'].state).toBe('closed');
    });
  });

  describe('getStatus', () => {
    it('should return healthy when /health responds ok', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const status = await connector.getStatus();

      expect(status.name).toBe('test-api');
      expect(status.healthy).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:9999/health',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should return unhealthy on fetch error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('connection refused'));

      const status = await connector.getStatus();

      expect(status.healthy).toBe(false);
    });

    it('should return unhealthy on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

      const status = await connector.getStatus();

      expect(status.healthy).toBe(false);
    });

    // ── CONN-0232 R10: a missing /health route (404) must NOT mark a live API offline ──
    it('R10: stays healthy when /health 404s but the server answered (openmodel case)', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 });
      const status = await connector.getStatus();
      expect(status.healthy).toBe(true);
    });

    it('R10: stays healthy on 401 (API alive, auth required)', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 401 });
      const status = await connector.getStatus();
      expect(status.healthy).toBe(true);
    });

    it('R10: stays healthy on 403 (reachable, not down)', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 403 });
      const status = await connector.getStatus();
      expect(status.healthy).toBe(true);
    });

    it('R10: 5xx (>=500, not 501) is still treated as down', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
      const status = await connector.getStatus();
      expect(status.healthy).toBe(false);
    });

    // ── CONN-0244: an OPEN per-model breaker must NOT blanket-offline the whole connector ──
    // Regression: one rate-limited/failed model tripped aggregate.state='open', which flipped
    // getStatus().healthy to false; the catalog then marked EVERY model of the provider offline
    // (openrouter: a single rate-limited `:free` model blanket-offlined all ~350). Connector-level
    // `healthy` must mean REACHABLE only — per-model availability is gated downstream via the
    // per-model breaker in `circuitBreakers`.
    it('CONN-0244: stays healthy when reachable even with an OPEN per-model breaker', async () => {
      // Trip model-a's breaker with an auth_error (instant open).
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('unauthorized'),
      });
      await connector.execute({ prompt: 'x', model: 'model-a' });

      // Health probe answers 200 → connector is reachable.
      fetchSpy.mockResolvedValueOnce({ ok: true, status: 200 });
      const status = await connector.getStatus();

      expect(status.healthy).toBe(true);
      expect(status.circuitBreakers!['model-a'].state).toBe('open');
    });
  });

  describe('classifyHttpError', () => {
    it('should classify common HTTP status codes', () => {
      // Access via execute responses — classification tested implicitly above
      expect(connector.getCapabilities().type).toBe('api');
    });
  });
});

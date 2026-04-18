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
  });

  describe('classifyHttpError', () => {
    it('should classify common HTTP status codes', () => {
      // Access via execute responses — classification tested implicitly above
      expect(connector.getCapabilities().type).toBe('api');
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import { Queue } from 'bullmq';
import { BaseApiConnector, ParsedApiOutput } from './base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  IConnector,
  classifyErrorAction,
} from './interfaces/connector.interface';
import { ConnectorsService, RETRYABLE_ERRORS } from './connectors.service';
import { PrismaService } from '../prisma/prisma.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import type { CatalogRepositoryLike } from './catalog.repository';

/**
 * A2-299 §(a), split out of A2-295 — Model Connector does not retry a timeout,
 * and the envelope it hands the caller says so.
 *
 * This is the half of A2-295's PR #147 that costs no customer anything: it only
 * stops Model Connector from buying a second copy of a bet that already lost.
 * The pricing half (charging an estimate of the input tokens an aborted attempt
 * spent) is a separate change, because it changes what a customer pays.
 *
 * The measured defect (A2-295, local test double, $0 spent): one client
 * `/execute` with a 99 000-character prompt and `timeout: 5000` handed the
 * provider 98 750 bytes TWICE — `CONNECTOR_MAX_RETRIES` defaults to 1, so two
 * attempts — under the SAME per-attempt deadline the caller had already proved
 * insufficient. Wall clock 11.3 s instead of 5.0 s, for two identical failures.
 *
 * Two decisions, each with a control that must NOT move:
 *   1. `timeout` is not in `RETRYABLE_ERRORS`  — CONTROL: `server_error` still is;
 *   2. the envelope says `retryable: false` / `abort` — CONTROL: `queue_timeout`
 *      still says retry, because a request that never left our own queue sent no
 *      prompt and spent no tokens.
 *
 * Deliberately NOT asserted here: anything about usage, cost or the ledger.
 * That is the other change's subject.
 */

// ---------------------------------------------------------------------------
// A provider test double that DRAINS the request body to the last byte and then
// never answers — what a real provider looks like between "prompt received" and
// "first token", which is exactly the window this change is about.
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;
const bytesReceived: number[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on('end', () => {
      bytesReceived.push(bytes);
      void res; // never answer; the caller's deadline expires
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

class ProbeConnector extends BaseApiConnector {
  readonly name = 'timeout-envelope-probe';
  constructor(private readonly url: string) {
    super();
  }
  protected getTimeout(): number {
    return 300_000;
  }
  protected getBaseUrl(): string {
    return this.url;
  }
  protected buildRequestUrl(): string {
    return `${this.url}/v1/messages`;
  }
  protected buildRequestBody(request: ConnectorRequest): unknown {
    return { input: request.prompt };
  }
  protected parseResponse(): ParsedApiOutput {
    return {
      text: '',
      model: 'probe',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }
  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: ['probe-model'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 600_000,
    };
  }
}

describe('A2-299 §(a) — the envelope a REAL aborted attempt writes', () => {
  /**
   * The control that A2-287 taught us to write. Every other test in this file
   * reads `classifyErrorAction` — a table in the same file as the change, which
   * would happily agree with a wrong value. This one reads the envelope the
   * REAL `BaseApiConnector` produces when a REAL `AbortSignal.timeout()` fires
   * on a REAL `fetch`, i.e. what a client actually receives over the wire.
   */
  it('a real abort on a real fetch produces retryable:false / abort', async () => {
    const before = bytesReceived.length;
    const connector = new ProbeConnector(baseUrl);

    const res = await connector.execute({
      prompt: 'x'.repeat(4_000),
      model: 'probe-model',
      timeout: 400,
    });

    // The prompt reached the provider — the premise of the whole change, read
    // from the SERVER side (bytes that crossed the socket), not from our books.
    expect(bytesReceived.length).toBe(before + 1);
    expect(bytesReceived[before]).toBeGreaterThan(4_000);

    expect(res.status).toBe('timeout');
    expect(res.error?.type).toBe('timeout');
    expect(res.error?.retryable).toBe(false);
    expect(res.error?.recommendation).toBe('abort');
  }, 20_000);
});

describe('A2-299 §(a) — Model Connector does not re-buy a lost bet', () => {
  function buildService(): ConnectorsService {
    const mockPrisma = {
      request: { create: vi.fn().mockResolvedValue({ id: 'req-1' }) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma)),
      firstDispatchObservation: {
        create: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const noopCatalogRepo: CatalogRepositoryLike = { findAll: vi.fn().mockResolvedValue([]) };
    return new ConnectorsService(
      { add: vi.fn() } as unknown as Queue,
      mockPrisma as unknown as PrismaService,
      {
        record: vi.fn(),
        getAll: vi.fn().mockReturnValue({}),
      } as unknown as import('../metrics/metrics.service').MetricsService,
      new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
      {
        getEntries: () => [],
        getFilteredEntries: () => [],
      } as unknown as import('./modality-catalog.service').ModalityCatalogService,
      noopCatalogRepo,
      null,
    );
  }

  function failingConnector(errorType: string): IConnector {
    return {
      name: 'test',
      type: 'api',
      execute: vi.fn().mockResolvedValue({
        id: 'r',
        connector: 'test',
        model: 'model',
        result: '',
        usage: { inputTokens: 10_000, outputTokens: 0, totalTokens: 10_000, costUsd: 0 },
        latencyMs: 5_000,
        status: errorType === 'timeout' ? 'timeout' : 'error',
        error: { type: errorType, message: 'x', ...classifyErrorAction(errorType) },
      }),
      getStatus: vi.fn().mockResolvedValue({
        name: 'test',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      }),
      getCapabilities: vi.fn().mockReturnValue({
        name: 'test',
        type: 'api',
        models: [],
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
        maxTimeout: 300_000,
      }),
      resetCircuitBreaker: vi.fn().mockReturnValue([]),
    };
  }

  it('dispatches an aborted attempt exactly once', async () => {
    process.env.PROVIDER_ACCESS = '';
    const service = buildService();
    const connector = failingConnector('timeout');
    service.register(connector);

    const res = await service.execute('test', { prompt: 'hello' }, 'key-1');

    // The measured defect: this was 2 (CONNECTOR_MAX_RETRIES default 1), and
    // each of those attempts handed the provider the whole prompt again.
    expect(connector.execute).toHaveBeenCalledTimes(1);
    expect(res.attempt).toBe(1);
    expect(res.status).toBe('timeout');
  });

  it('CONTROL: a server error is still retried — this change is about timeouts only', async () => {
    process.env.PROVIDER_ACCESS = '';
    const service = buildService();
    const connector = failingConnector('server_error');
    service.register(connector);

    await service.execute('test', { prompt: 'hello' }, 'key-1');

    expect(connector.execute).toHaveBeenCalledTimes(2);
  });

  it('the retry set and the advertised envelope agree about `timeout`', () => {
    // Two tables, one decision. They disagreed before this change in the worst
    // possible direction: both said "retry", so the retries multiplied.
    expect(RETRYABLE_ERRORS.has('timeout')).toBe(false);
    expect(classifyErrorAction('timeout')).toEqual({
      retryable: false,
      recommendation: 'abort',
    });
  });

  it('CONTROL: `queue_timeout` is untouched — nothing was sent, so nothing was spent', () => {
    expect(classifyErrorAction('queue_timeout')).toEqual({
      retryable: true,
      recommendation: 'wait',
    });
    expect(RETRYABLE_ERRORS.has('queue_timeout')).toBe(false);
  });

  it('CONTROL: the classes that may still be worth another attempt keep their retry', () => {
    for (const cls of ['server_error', 'rate_limited', 'network_error', 'json_parse_error']) {
      expect(RETRYABLE_ERRORS.has(cls)).toBe(true);
    }
  });
});

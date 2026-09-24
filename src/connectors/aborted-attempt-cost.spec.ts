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
import { measureCostUsd } from '../billing/measured-cost';
import type { CatalogRepositoryLike } from './catalog.repository';

/**
 * A2-295 — an aborted upstream attempt is spend, and Model Connector reported
 * it as $0 and then bought more of it.
 *
 * The incident these tests are written from (A2-278 receipt, re-measured on a
 * local test double for A2-295): one client `/execute` with a 99 000-character
 * prompt and `timeout: 5000` handed the provider 98 750 bytes TWICE, answered
 * `usage: {inputTokens: 0, costUsd: 0, costSource: 'zero-usage'}` both times,
 * and settled `credits_ledger` at $0.000000. On the real run the provider
 * invoiced $0.086584 for the same shape of call. No `max_cost_usd` anywhere in
 * the stack could see any of it, because every layer was reading a zero.
 *
 * Three decisions are asserted here, each with a control that must NOT move:
 *
 *   1. an aborted attempt reports ESTIMATED input tokens, flagged as ours;
 *      a connection that never opened still reports zero;
 *   2. `timeout` is not retried by Model Connector; `server_error` still is;
 *   3. the envelope says `abort`; `queue_timeout` still says retry.
 *
 * The abort is produced by a REAL `AbortSignal.timeout()` firing on a REAL
 * `fetch` against a local server, the same way `timeout-classification.spec.ts`
 * does it — a hand-built DOMException would assert what we wish Node did.
 */

// ---------------------------------------------------------------------------
// The provider test double. It differs from the hanging server in
// timeout-classification.spec.ts in the one way that matters to billing: it
// DRAINS the request body to the last byte before going quiet, which is what a
// real provider does before it starts generating. That is the whole basis for
// charging the input tokens — by the time we hang up, they are spent.
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;
/** Bytes of prompt the provider actually received, per request. */
const bytesReceived: number[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on('end', () => {
      bytesReceived.push(bytes);
      // Body is in. Now never answer — the caller's deadline expires.
      void res;
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
  readonly name = 'abort-cost-probe';
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

/** A prompt whose character count is a round number of estimated tokens. */
const PROMPT = 'x'.repeat(40_000); // 40 000 chars / 4 chars-per-token = 10 000 tokens
const EXPECTED_TOKENS = 10_000;
/** Long enough for the request body to be fully written and drained. */
const SHORT_MS = 400;

describe('A2-295 — an aborted attempt reports what it spent', () => {
  it('reports estimated input tokens, flagged as ours, for an attempt the provider was paid for', async () => {
    const before = bytesReceived.length;
    const connector = new ProbeConnector(baseUrl);

    const res = await connector.execute({
      prompt: PROMPT,
      model: 'probe-model',
      timeout: SHORT_MS,
    });

    // The abort really happened, and it is classified as one.
    expect(res.status).toBe('timeout');
    expect(res.error?.type).toBe('timeout');

    // The provider really received the prompt. This is the fact the charge
    // rests on, and it is read from the SERVER side — from what the real
    // socket delivered — not from the connector's own bookkeeping.
    expect(bytesReceived.length).toBe(before + 1);
    expect(bytesReceived[before]).toBeGreaterThan(40_000);

    // ...and the response says so, instead of `0`.
    expect(res.usage.inputTokens).toBe(EXPECTED_TOKENS);
    expect(res.usage.totalTokens).toBe(EXPECTED_TOKENS);
    expect(res.usage.estimated).toBe(true);

    // Output is NOT guessed. Whatever the provider generated before we hung up
    // is unknowable, and inventing it would bill for text nobody received.
    expect(res.usage.outputTokens).toBe(0);
  });

  it('names the budget, the model and what to do instead of repeating the request', async () => {
    const connector = new ProbeConnector(baseUrl);
    const res = await connector.execute({
      prompt: 'short',
      model: 'probe-model',
      timeout: SHORT_MS,
    });

    const message = res.error?.message ?? '';
    expect(message).toContain(String(SHORT_MS));
    expect(message).toContain('probe-model');
    // The operator's next move has to be IN the message: `ErrorAction` has four
    // values and "raise the budget" is not one of them.
    expect(message).toMatch(/raise `timeout`|faster model/);
  });

  it('CONTROL: a connection that never opened still reports zero usage', async () => {
    // Port 1 on loopback refuses instantly: no body was ever written, so no
    // tokens were spent and zero is the measurement rather than a false one.
    const connector = new ProbeConnector('http://127.0.0.1:1');
    const res = await connector.execute({
      prompt: PROMPT,
      model: 'probe-model',
      timeout: 5_000,
    });

    expect(res.error?.type).toBe('network_error');
    expect(res.usage.inputTokens).toBe(0);
    expect(res.usage.estimated).toBeUndefined();
  });
});

describe('A2-295 — an estimated count is charged, and is findable as estimated', () => {
  const pricing = { inputPerMTok: 1.74, outputPerMTok: 3.48, tier: 'standard' };

  it('prices estimated tokens at the catalogue tariff but never calls them measured', () => {
    const metered = measureCostUsd({ inputTokens: EXPECTED_TOKENS, pricing, estimatedUsage: true });

    expect(metered.costUsd).toBeCloseTo(0.0174, 6);
    // NOT 'catalog'. The tariff is the catalogue's; the token count is ours,
    // and a reconciliation must be able to separate the two.
    expect(metered.source).toBe('estimated-input');
  });

  it('CONTROL: the same tokens reported BY the provider stay `catalog`', () => {
    const metered = measureCostUsd({ inputTokens: EXPECTED_TOKENS, pricing });
    expect(metered.costUsd).toBeCloseTo(0.0174, 6);
    expect(metered.source).toBe('catalog');
  });

  it('recovers the A2-278 input spend that was recorded as zero', () => {
    // The real incident: 37 417 input tokens at 1.74/MTok on the receipt.
    const metered = measureCostUsd({ inputTokens: 37_417, pricing, estimatedUsage: true });
    expect(metered.costUsd).toBeCloseTo(0.065106, 6);
    // The whole receipt was $0.086584 (6 172 output tokens on top). The
    // estimate recovers the input side and no more — an understatement by
    // construction, against the $0.000000 it replaces.
    expect(metered.costUsd).toBeLessThan(0.086584);
  });

  it('an estimate of nothing is still nothing', () => {
    const metered = measureCostUsd({ inputTokens: 0, pricing, estimatedUsage: true });
    expect(metered.source).toBe('zero-usage');
    expect(metered.costUsd).toBe(0);
  });
});

describe('A2-295 — Model Connector does not re-buy a lost bet', () => {
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
  });
});

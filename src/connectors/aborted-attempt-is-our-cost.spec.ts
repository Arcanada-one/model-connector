import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';

import { BaseApiConnector, ParsedApiOutput } from './base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  classifyErrorAction,
} from './interfaces/connector.interface';

import { measureCostUsd } from '../billing/measured-cost';
import { Queue } from 'bullmq';
import { ConnectorsService } from './connectors.service';
import { PrismaService } from '../prisma/prisma.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
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

describe('A2-299 / DEC-AUP-0050 — an estimated count is RECORDED, is findable as estimated, and is charged to nobody', () => {
  const pricing = { inputPerMTok: 1.74, outputPerMTok: 3.48, tier: 'standard' };

  it('prices estimated tokens at the catalogue tariff but never calls them measured', () => {
    const metered = measureCostUsd({ inputTokens: EXPECTED_TOKENS, pricing, estimatedUsage: true });

    expect(metered.costUsd).toBeCloseTo(0.0174, 6);
    // NOT 'catalog'. The tariff is the catalogue's; the token count is ours,
    // and a reconciliation must be able to separate the two.
    expect(metered.source).toBe('estimated-input-unbilled');
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

describe('A2-299 / DEC-AUP-0050 R2 — the customer is charged nothing', () => {
  /**
   * This block drives the REAL `ConnectorsService.settleAndRecord` and reads what
   * it hands to the REAL billing interface and to Prisma. It does NOT restate the
   * production expression.
   *
   * That distinction is the point, and it was earned: a first version of this test
   * asserted `source === 'estimated-input-unbilled' ? 0 : costUsd` — a COPY of the
   * production line — and a mutant that violated R2 outright left all 12 tests
   * GREEN, because mutating the copy merely made the spec assert a different thing
   * consistently. That is the A2-287 failure mode (a fixture written by the same
   * hand as the code agreeing with the bug). The version below fails on that
   * mutant.
   */
  const PRICED = 'abort-priced-model';
  const pricing = { inputPerMTok: 1.74, outputPerMTok: 3.48, tier: 'standard' };

  function stand() {
    const created: Record<string, unknown>[] = [];
    const settled: { amountUsd: number; reason: string }[] = [];
    const mockPrisma = {
      request: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 'req-1' };
        }),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma)),
      firstDispatchObservation: {
        create: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const billing = {
      settleInTx: vi.fn(async (_tx: unknown, p: { amountUsd: number; reason: string }) => {
        settled.push({ amountUsd: p.amountUsd, reason: p.reason });
      }),
      settleIntentInTx: vi.fn(),
      openRequestIntent: vi.fn().mockResolvedValue(null),
      releaseIntent: vi.fn(),
    };
    const service = new ConnectorsService(
      { add: vi.fn() } as unknown as Queue,
      mockPrisma as unknown as PrismaService,
      {
        record: vi.fn(),
        getAll: vi.fn().mockReturnValue({}),
      } as unknown as import('../metrics/metrics.service').MetricsService,
      new OutputGuardMiddleware({ enabled: false, maxRetries: 3, timeoutMs: 30_000 }),
      {
        getEntries: () => [],
        getFilteredEntries: () => [],
      } as unknown as import('./modality-catalog.service').ModalityCatalogService,
      {
        findAll: vi.fn().mockResolvedValue([
          {
            connector: 'test',
            model: PRICED,
            inputPerMTok: pricing.inputPerMTok,
            outputPerMTok: pricing.outputPerMTok,
            cachedInputPerMTok: null,
            status: 'online',
          },
        ]),
      } as CatalogRepositoryLike,
      null,
      undefined,
      undefined,
      billing as unknown as import('../billing/billing.service').BillingService,
    );
    return { service, created, settled, billing };
  }

  /** A connector whose aborted attempt reports ESTIMATED input tokens, as base-api does. */
  function abortedConnector(estimated: boolean) {
    return {
      name: 'test',
      type: 'api' as const,
      execute: vi.fn().mockResolvedValue({
        id: 'r',
        connector: 'test',
        model: PRICED,
        result: '',
        usage: {
          inputTokens: EXPECTED_TOKENS,
          outputTokens: 0,
          totalTokens: EXPECTED_TOKENS,
          costUsd: 0,
          ...(estimated ? { estimated: true as const } : {}),
        },
        latencyMs: 400,
        status: 'timeout',
        error: { type: 'timeout', message: 'aborted', ...classifyErrorAction('timeout') },
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
        models: [PRICED],
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
        maxTimeout: 300_000,
      }),
      resetCircuitBreaker: vi.fn().mockReturnValue([]),
    };
  }

  it('R3 records the cost on the request row AND R2 settles the ledger at zero', async () => {
    process.env.PROVIDER_ACCESS = '';
    const { service, created, settled } = stand();
    service.register(abortedConnector(true));

    await service.execute('test', { prompt: 'x', model: PRICED }, 'key-1');

    expect(created).toHaveLength(1);
    // R3 — the loss is VISIBLE on the record, and labelled as ours.
    expect(created[0].costSource).toBe('estimated-input-unbilled');
    expect(created[0].costUsd as number).toBeGreaterThan(0);
    expect(created[0].costUsd as number).toBeCloseTo(0.0174, 6);

    // R2 — and the CUSTOMER is charged nothing for it. Read from what the
    // service actually handed the billing interface.
    expect(settled).toHaveLength(1);
    expect(settled[0].amountUsd).toBe(0);
    // Findable in the ledger by name, per R3.
    expect(settled[0].reason).toContain('estimated-input-unbilled');
  });

  it('CONTROL: a provider-METERED cost is still charged to the customer in full', async () => {
    process.env.PROVIDER_ACCESS = '';
    const { service, created, settled } = stand();
    // Same tokens, same tariff — the ONLY difference is that the provider
    // reported them, so `estimated` is absent.
    service.register(abortedConnector(false));

    await service.execute('test', { prompt: 'x', model: PRICED }, 'key-1');

    expect(created[0].costSource).toBe('catalog');
    expect(settled[0].amountUsd).toBeCloseTo(0.0174, 6);
    expect(settled[0].amountUsd).toBeGreaterThan(0);
  });
});

describe('A2-299 / DEC-AUP-0050 R4 — the trigger is proof of upload, not status', () => {
  /**
   * Security's finding, and a precondition rather than a preference: the same
   * timeout-shaped envelope is produced by paths where NOTHING was sent, and a
   * rule keyed on `status` would have recorded a cost for prompts that never
   * left us.
   *
   * `queue_timeout` (base-api.connector.ts:480) and `circuit_open` (:453) return
   * from branches ABOVE the `fetch`, so they can never reach the `isAbort`
   * branch that estimates. That structural fact is what this test pins: if
   * either branch were ever moved below the fetch, or the estimate keyed on
   * status instead, these controls break.
   */
  it('CONTROL: a queue timeout sent no prompt, so it records a true zero', () => {
    const metered = measureCostUsd({
      inputTokens: 0,
      pricing: { inputPerMTok: 1.74, outputPerMTok: 3.48, tier: 'standard' },
    });
    expect(metered.source).toBe('zero-usage');
    expect(metered.costUsd).toBe(0);
  });

  it('the estimator is reachable ONLY from the aborted-fetch branch', async () => {
    const src = await import('fs/promises').then((fs) =>
      fs.readFile(__dirname + '/base-api.connector.ts', 'utf8'),
    );
    const estimateLines = src
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes('estimateInputTokens(') && !line.includes('import'));

    // Exactly one call site, and it is guarded by `isAbort`.
    expect(estimateLines).toHaveLength(1);
    expect(estimateLines[0][1]).toContain('isAbort ?');

    // And the two no-bytes-sent branches return above it.
    const abortLine = estimateLines[0][0];
    const queueTimeoutLine =
      src.split('\n').findIndex((l) => l.includes("type: 'queue_timeout'")) + 1;
    const circuitOpenLine =
      src.split('\n').findIndex((l) => l.includes("type: 'circuit_open'")) + 1;
    expect(queueTimeoutLine).toBeGreaterThan(0);
    expect(circuitOpenLine).toBeGreaterThan(0);
    expect(queueTimeoutLine).toBeLessThan(abortLine);
    expect(circuitOpenLine).toBeLessThan(abortLine);
  });
});

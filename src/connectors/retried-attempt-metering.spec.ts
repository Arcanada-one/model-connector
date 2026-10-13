import { describe, it, expect, vi } from 'vitest';
import { Queue } from 'bullmq';
import {
  ConnectorCapabilities,
  ConnectorResponse,
  IConnector,
  classifyErrorAction,
} from './interfaces/connector.interface';
import { ConnectorsService } from './connectors.service';
import { PrismaService } from '../prisma/prisma.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import type { CatalogRepositoryLike } from './catalog.repository';

/**
 * A2-299 §4 — the meter sees only the LAST attempt, so a retried request's
 * earlier provider consumption is thrown away.
 *
 * `connectors.service.ts` keeps one variable for the attempt loop's result:
 *
 *     response.attempt = attempt;
 *     lastResponse = response;          // <- overwrites attempt N-1
 *     ...
 *     const unmetered = lastResponse!;  // <- the meter's ONLY input
 *
 * For a class where the provider never answered, discarding the attempt costs
 * nothing to discard — there are no token counts to lose. But several retryable
 * classes are the opposite case: the provider answered **200 with a usage
 * object** and we retried because we did not like the BODY —
 * `json_parse_error`, `parse_error`, `structured_output_error`. Those tokens
 * were generated, the provider bills them, and Model Connector charges $0 for
 * every attempt but the last.
 *
 * Measured shape below: attempt 1 returns `json_parse_error` WITH
 * 1 000 in / 500 out reported by the provider; attempt 2 succeeds with
 * 1 000 in / 500 out. The provider consumed 2 000 in / 1 000 out. Before the
 * fix the request is metered at 1 000 / 500 — exactly half of it invisible.
 *
 * The control that must not move: a single-attempt request is metered at
 * exactly what it consumed, unchanged, and an aborted attempt with no usage to
 * recover adds nothing (this change recovers provider-MEASURED tokens only; it
 * does not invent any, which is the separate pricing question in A2-299 §(b)).
 */

const PRICED_MODEL = 'metered-model';

function buildService(): ConnectorsService {
  const mockPrisma = {
    request: { create: vi.fn().mockResolvedValue({ id: 'req-1' }) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma)),
    firstDispatchObservation: {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  // A real catalogue row, so the meter prices the tokens instead of recording
  // them `unpriced` — the charge is the point of the test.
  const catalogRepo: CatalogRepositoryLike = {
    findAll: vi.fn().mockResolvedValue([
      {
        connector: 'test',
        model: PRICED_MODEL,
        inputPerMTok: 1_000,
        outputPerMTok: 2_000,
        cachedInputPerMTok: null,
        status: 'online',
      },
    ]),
  };
  return new ConnectorsService(
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
    catalogRepo,
    null,
  );
}

function resp(
  status: ConnectorResponse['status'],
  errorType: string | null,
  inputTokens: number,
  outputTokens: number,
): ConnectorResponse {
  return {
    id: 'r',
    connector: 'test',
    model: PRICED_MODEL,
    result: status === 'success' ? 'ok' : '',
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: 0,
    },
    latencyMs: 10,
    status,
    ...(errorType
      ? { error: { type: errorType, message: 'x', ...classifyErrorAction(errorType) } }
      : {}),
  } as ConnectorResponse;
}

/** A connector that answers from a script, one entry per attempt. */
function scriptedConnector(script: ConnectorResponse[]): IConnector {
  let i = 0;
  return {
    name: 'test',
    type: 'api',
    execute: vi
      .fn()
      .mockImplementation(async () => ({ ...script[Math.min(i++, script.length - 1)] })),
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
      models: [PRICED_MODEL],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
    } satisfies ConnectorCapabilities),
    resetCircuitBreaker: vi.fn().mockReturnValue([]),
  };
}

describe('A2-299 §4 — a retried request is metered for every attempt the provider billed', () => {
  it('counts the provider-reported tokens of a discarded attempt, not just the last', async () => {
    process.env.PROVIDER_ACCESS = '';
    const service = buildService();
    const connector = scriptedConnector([
      // The provider ANSWERED 200 and reported usage; we retried over the body.
      resp('error', 'json_parse_error', 1_000, 500),
      resp('success', null, 1_000, 500),
    ]);
    service.register(connector);

    const res = await service.execute('test', { prompt: 'hello', model: PRICED_MODEL }, 'key-1');

    expect(connector.execute).toHaveBeenCalledTimes(2);
    expect(res.status).toBe('success');

    // The provider generated this twice. Before the fix: 1 000 / 500.
    expect(res.usage.inputTokens).toBe(2_000);
    expect(res.usage.outputTokens).toBe(1_000);
    // 2 000/1e6 * 1 000 + 1 000/1e6 * 2 000 = 2.0 + 2.0 = 4.0
    expect(res.usage.costUsd).toBeCloseTo(4.0, 6);
  });

  it('CONTROL: a single-attempt success is metered at exactly what it consumed', async () => {
    process.env.PROVIDER_ACCESS = '';
    const service = buildService();
    const connector = scriptedConnector([resp('success', null, 1_000, 500)]);
    service.register(connector);

    const res = await service.execute('test', { prompt: 'hello', model: PRICED_MODEL }, 'key-1');

    expect(connector.execute).toHaveBeenCalledTimes(1);
    expect(res.usage.inputTokens).toBe(1_000);
    expect(res.usage.outputTokens).toBe(500);
    expect(res.usage.costUsd).toBeCloseTo(2.0, 6);
  });

  it('CONTROL: an attempt that reported no usage recovers nothing — no number is invented', async () => {
    process.env.PROVIDER_ACCESS = '';
    const service = buildService();
    // `server_error` is retryable and reports zero usage: the provider never
    // produced a usage object. A2-299 §(b) is the separate question of whether
    // an estimate belongs here; this change must NOT pre-empt it.
    const connector = scriptedConnector([
      resp('error', 'server_error', 0, 0),
      resp('success', null, 1_000, 500),
    ]);
    service.register(connector);

    const res = await service.execute('test', { prompt: 'hello', model: PRICED_MODEL }, 'key-1');

    expect(connector.execute).toHaveBeenCalledTimes(2);
    expect(res.usage.inputTokens).toBe(1_000);
    expect(res.usage.outputTokens).toBe(500);
    expect(res.usage.costUsd).toBeCloseTo(2.0, 6);
  });

  it('CONTROL: the last attempt still decides the STATUS and the body', async () => {
    process.env.PROVIDER_ACCESS = '';
    const service = buildService();
    const connector = scriptedConnector([
      resp('error', 'json_parse_error', 1_000, 500),
      resp('success', null, 7, 3),
    ]);
    service.register(connector);

    const res = await service.execute('test', { prompt: 'hello', model: PRICED_MODEL }, 'key-1');

    expect(res.status).toBe('success');
    expect(res.result).toBe('ok');
    expect(res.attempt).toBe(2);
    // The recovered tokens are added to the meter, they do not replace it.
    expect(res.usage.inputTokens).toBe(1_007);
    expect(res.usage.outputTokens).toBe(503);
  });
});

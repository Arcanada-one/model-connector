import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Queue } from 'bullmq';
import { ConnectorsService } from './connectors.service';
import { NotFoundException } from '@nestjs/common';
import { IConnector } from './interfaces/connector.interface';
import { PrismaService } from '../prisma/prisma.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import { entryToRow } from './catalog-mapper';
import {
  entryMatchesFilters,
  type CatalogFilters,
  type CatalogModelEntry,
} from './dto/catalog.dto';
import type { CatalogRepositoryLike, ModelCatalogRow } from './catalog.repository';
import type { ICatalogRedis } from './catalog-redis.token';

// CONN-0245 — DB-as-source-of-truth catalog: builds a narrow CatalogRepository
// mock whose `findAll()` returns rows equivalent to a given entry list (via
// the real `entryToRow` mapper), so getCatalog() read-path tests exercise the
// actual write→read round trip instead of an arbitrary hand-rolled row shape.
// CONN-0245 — buildCatalogSnapshot() is now unfiltered (the cron persists
// EVERYTHING; entryMatchesFilters only runs against DB rows on the
// getCatalog() read path). Assembly-shape tests below reproduce the exact
// pre-CONN-0245 `getCatalog(filters)` behavior by composing the unchanged
// assembly (`buildCatalogSnapshot`) with the same, still-shared
// `entryMatchesFilters` — i.e. this IS the old getCatalog(filters) body,
// just decomposed into its two now-separate halves.
async function assembleFiltered(
  svc: ConnectorsService,
  filters: CatalogFilters,
): Promise<CatalogModelEntry[]> {
  const all = await svc.buildCatalogSnapshot();
  return all.filter((e) => entryMatchesFilters(e, filters));
}

function repoFromEntries(entries: CatalogModelEntry[]): CatalogRepositoryLike {
  const rows: ModelCatalogRow[] = entries.map((entry, i) => ({
    ...entryToRow(entry),
    id: `row-${i}`,
    firstSeen: new Date('2026-07-01T00:00:00.000Z'),
    lastSeen: new Date('2026-07-05T16:00:00.000Z'),
    absent: false,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-05T16:00:00.000Z'),
  }));
  return { findAll: vi.fn().mockResolvedValue(rows) };
}

describe('ConnectorsService', () => {
  let service: ConnectorsService;
  const mockQueue = { add: vi.fn() };
  const mockPrisma = { request: { create: vi.fn().mockResolvedValue({}) } };
  const mockMetrics = { record: vi.fn(), getAll: vi.fn().mockReturnValue({}) };
  // No-op repo/cache for tests that don't exercise getCatalog's DB read path
  // (execute/retry/output-guard/etc. — unrelated to the catalog).
  const noopCatalogRepo: CatalogRepositoryLike = { findAll: vi.fn().mockResolvedValue([]) };
  const noopCatalogRedis: ICatalogRedis | null = null;

  const mockConnector: IConnector = {
    name: 'test',
    type: 'cli',
    execute: vi.fn().mockResolvedValue({
      id: 'resp-1',
      connector: 'test',
      model: 'model',
      result: 'ok',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 },
      latencyMs: 50,
      status: 'success',
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
      type: 'cli',
      models: [],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300000,
    }),
  };

  // CONN-0232: existing chat-focused tests use an EMPTY static modality catalog
  // so their counts/availability assertions stay about registered connectors.
  // Completeness tests below construct a service with the real ModalityCatalogService.
  const emptyModalityCatalog = {
    getEntries: () => [],
    getFilteredEntries: () => [],
  } as unknown as import('./modality-catalog.service').ModalityCatalogService;

  beforeEach(() => {
    // CONN-0244 — baseline: all providers fully enabled unless a test opts into PROVIDER_ACCESS.
    process.env.PROVIDER_ACCESS = '';
    service = new ConnectorsService(
      mockQueue as unknown as Queue,
      mockPrisma as unknown as PrismaService,
      mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
      new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
      emptyModalityCatalog,
      noopCatalogRepo,
      noopCatalogRedis,
    );
    vi.clearAllMocks();
  });

  it('should register and get a connector', () => {
    service.register(mockConnector);
    expect(service.get('test')).toBe(mockConnector);
  });

  it('should throw NotFoundException for unknown connector', () => {
    expect(() => service.get('nonexistent')).toThrow(NotFoundException);
  });

  it('should list connector names', () => {
    service.register(mockConnector);
    expect(service.listNames()).toEqual(['test']);
  });

  describe('execute() modality gate (CONN-0239)', () => {
    const metaConnector: IConnector = {
      ...mockConnector,
      name: 'metacon',
      execute: vi.fn().mockResolvedValue({
        id: 'r',
        connector: 'metacon',
        model: 'm',
        result: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
        latencyMs: 1,
        status: 'success',
      }),
      getCapabilities: vi.fn().mockReturnValue({
        name: 'metacon',
        type: 'api',
        models: ['chat-m', 'whisper-m', 'guard-m', 'img-m'],
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
        maxTimeout: 300000,
        modelMeta: [
          { id: 'chat-m', modality: 'chat' },
          { id: 'whisper-m', modality: 'speech_to_text' },
          { id: 'guard-m', modality: 'moderation' },
          { id: 'img-m', modality: 'image_generation' },
        ],
      }),
    };

    it.each(['whisper-m', 'img-m'])(
      'rejects a non-chat model (%s) with unsupported_modality WITHOUT calling the provider',
      async (model) => {
        service.register(metaConnector);
        const res = await service.execute('metacon', { prompt: 'x', model }, 'k');
        expect(res.status).toBe('error');
        expect(res.error?.type).toBe('unsupported_modality');
        expect(metaConnector.execute).not.toHaveBeenCalled();
      },
    );

    it('allows chat and moderation models through to the provider', async () => {
      service.register(metaConnector);
      const chat = await service.execute('metacon', { prompt: 'x', model: 'chat-m' }, 'k');
      const mod = await service.execute('metacon', { prompt: 'x', model: 'guard-m' }, 'k');
      expect(chat.status).toBe('success');
      expect(mod.status).toBe('success');
      expect(metaConnector.execute).toHaveBeenCalledTimes(2);
    });

    it('does NOT block a model unknown to modelMeta (default chat assumption)', async () => {
      service.register(metaConnector);
      const res = await service.execute('metacon', { prompt: 'x', model: 'unknown-id' }, 'k');
      expect(res.status).toBe('success');
      expect(metaConnector.execute).toHaveBeenCalled();
    });
  });

  describe('execute() USE gate (CONN-0245-EXT — DB-backed ProviderAccessService)', () => {
    it('a DB-seeded USE=off provider is refused with provider_not_routable WITHOUT calling the connector', async () => {
      const gatedService = new ConnectorsService(
        mockQueue as unknown as Queue,
        mockPrisma as unknown as PrismaService,
        mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
        new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
        emptyModalityCatalog,
        noopCatalogRepo,
        noopCatalogRedis,
        {
          seedDefaults: vi.fn(),
          refresh: vi.fn(),
          getAccess: vi.fn().mockReturnValue({ read: true, use: false }),
        },
      );
      gatedService.register(mockConnector);

      const res = await gatedService.execute('test', { prompt: 'hello' }, 'key-1');

      expect(res.status).toBe('error');
      expect(res.error?.type).toBe('provider_not_routable');
      expect(mockConnector.execute).not.toHaveBeenCalled();
    });

    it('USE=on (default fail-open stub, falls through to PROVIDER_ACCESS config) — zero behavior change', async () => {
      // `service` (the shared beforeEach instance) uses the constructor
      // default providerAccess stub, which itself falls through to the exact
      // CONN-0244 config computation (process.env.PROVIDER_ACCESS = '' from
      // the outer beforeEach ⇒ fully enabled).
      service.register(mockConnector);
      const result = await service.execute('test', { prompt: 'hello' }, 'key-1');
      expect(result.status).toBe('success');
      expect(mockConnector.execute).toHaveBeenCalledOnce();
    });
  });

  it('should execute via connector directly', async () => {
    service.register(mockConnector);
    const result = await service.execute('test', { prompt: 'hello' }, 'key-1');
    expect(result.status).toBe('success');
    expect(mockConnector.execute).toHaveBeenCalledOnce();
  });

  it('should return status for registered connector', async () => {
    service.register(mockConnector);
    const status = await service.getStatus('test');
    expect(status.name).toBe('test');
    expect(status.healthy).toBe(true);
  });

  it('should list all connectors with capabilities', async () => {
    service.register(mockConnector);
    const list = await service.listAll();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('test');
  });

  describe('retry logic', () => {
    it('should retry on json_parse_error and succeed on second attempt', async () => {
      const retryConnector: IConnector = {
        ...mockConnector,
        name: 'test',
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'r1',
            connector: 'test',
            model: 'model',
            result: 'not-json',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 },
            latencyMs: 50,
            status: 'success',
          })
          .mockResolvedValueOnce({
            id: 'r2',
            connector: 'test',
            model: 'model',
            result: '{"key": "value"}',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 },
            latencyMs: 50,
            status: 'success',
          }),
      };

      service.register(retryConnector);
      const result = await service.execute(
        'test',
        { prompt: 'hello', responseFormat: { type: 'json_object' } },
        'key-1',
      );

      expect(retryConnector.execute).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('success');
      expect(result.attempt).toBe(2);
      expect(result.structured).toEqual({ key: 'value' });
    });

    it('should not retry on auth_error', async () => {
      const authErrorConnector: IConnector = {
        ...mockConnector,
        name: 'test',
        execute: vi.fn().mockResolvedValue({
          id: 'r1',
          connector: 'test',
          model: 'model',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 50,
          status: 'error',
          error: {
            type: 'auth_error',
            message: 'Not logged in',
            retryable: false,
            recommendation: 'reauth',
          },
        }),
      };

      service.register(authErrorConnector);
      const result = await service.execute('test', { prompt: 'hello' }, 'key-1');

      expect(authErrorConnector.execute).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('error');
      expect(result.attempt).toBe(1);
      expect(result.error?.type).toBe('auth_error');
    });

    it('should respect maxAttempts limit', async () => {
      const failConnector: IConnector = {
        ...mockConnector,
        name: 'test',
        execute: vi.fn().mockResolvedValue({
          id: 'r1',
          connector: 'test',
          model: 'model',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 50,
          status: 'error',
          error: {
            type: 'timeout',
            message: 'timed out',
            retryable: true,
            recommendation: 'retry',
          },
        }),
      };

      service.register(failConnector);
      const result = await service.execute('test', { prompt: 'hello' }, 'key-1');

      // CONNECTOR_MAX_RETRIES defaults to 1, so max 2 attempts
      expect(failConnector.execute).toHaveBeenCalledTimes(2);
      expect(result.attempt).toBe(2);
      expect(result.maxAttempts).toBe(2);
      expect(result.status).toBe('error');
    });

    it('should apply JSON sanitization to successful response', async () => {
      service.register(mockConnector);
      vi.mocked(mockConnector.execute).mockResolvedValueOnce({
        id: 'r1',
        connector: 'test',
        model: 'model',
        result: '```json\n{"sanitized": true}\n```',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0 },
        latencyMs: 50,
        status: 'success',
      });

      const result = await service.execute(
        'test',
        { prompt: 'hello', responseFormat: { type: 'json_object' } },
        'key-1',
      );

      expect(result.status).toBe('success');
      expect(result.structured).toEqual({ sanitized: true });
      expect(result.result).toBe('{"sanitized": true}');
    });
  });

  // CONN-0226 ------------------------------------------------------------------
  describe('buildCatalogSnapshot (CONN-0226/0232/0238 — full assembly, moved off the request path)', () => {
    // CONN-0245: this describe block used to exercise `getCatalog(filters)`
    // directly (assembly + filter + envelope in one call). getCatalog() now
    // reads the DB; buildCatalogSnapshot() is where the (unchanged) assembly
    // logic these tests actually verify still lives. `assembleFiltered()`
    // reproduces the exact old `getCatalog(filters)` result shape (assembly
    // then `entryMatchesFilters`) so every assertion below keeps its original
    // meaning byte-for-byte — nothing here is weakened.
    const noFilters: CatalogFilters = { free: false, cheap: false, capability: undefined };

    const openmodelConnector: IConnector = {
      name: 'openmodel',
      type: 'api',
      execute: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({
        name: 'openmodel',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      }),
      getCapabilities: vi.fn().mockReturnValue({
        name: 'openmodel',
        type: 'api',
        models: ['deepseek-v4-flash', 'deepseek-r2', 'qwen3-235b'],
        supportsStreaming: false,
        supportsJsonSchema: true,
        supportsTools: false,
        maxTimeout: 120_000,
        // CONN-0244 — OpenModel is a paid gateway: no free models.
        freeModels: [],
      }),
      resetCircuitBreaker: vi.fn().mockReturnValue([]),
    };

    // CONN-0244 — a genuinely-free provider fixture (openmodel is no longer free), used by the
    // free-filter mechanism test below.
    const freeProviderConnector: IConnector = {
      name: 'groq',
      type: 'api',
      execute: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({
        name: 'groq',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      }),
      getCapabilities: vi.fn().mockReturnValue({
        name: 'groq',
        type: 'api',
        models: ['llama-3.3-70b-versatile'],
        supportsStreaming: false,
        supportsJsonSchema: true,
        supportsTools: true,
        maxTimeout: 120_000,
        freeModels: ['llama-3.3-70b-versatile'],
      }),
      resetCircuitBreaker: vi.fn().mockReturnValue([]),
    };

    const cliConnector: IConnector = {
      name: 'claude-code',
      type: 'cli',
      execute: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({
        name: 'claude-code',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      }),
      getCapabilities: vi.fn().mockReturnValue({
        name: 'claude-code',
        type: 'cli',
        models: ['claude-sonnet-4-5', 'claude-opus-4'],
        supportsStreaming: false,
        supportsJsonSchema: true,
        supportsTools: true,
        maxTimeout: 300_000,
      }),
      resetCircuitBreaker: vi.fn().mockReturnValue([]),
    };

    it('returns all models from all connectors with no filters', async () => {
      service.register(openmodelConnector);
      service.register(cliConnector);
      const result = await assembleFiltered(service, noFilters);
      // openmodel: 3 models; claude-code: 2 models
      expect(result).toHaveLength(5);
    });

    it('CONN-0244: openmodel deepseek-v4-flash is NOT free (paid gateway, price_multiplier=1)', async () => {
      service.register(openmodelConnector);
      const result = await assembleFiltered(service, noFilters);
      const flash = result.find((m) => m.model === 'deepseek-v4-flash');
      expect(flash?.free).toBe(false);
      expect(flash?.cheap).toBe(true); // price_multiplier=1 = cheap-but-paid
      expect(flash?.priceMultiplier).toBe(1);
    });

    describe('CONN-0244 — per-provider READ/USE access (PROVIDER_ACCESS)', () => {
      const prev = process.env.PROVIDER_ACCESS;
      afterEach(() => {
        if (prev === undefined) delete process.env.PROVIDER_ACCESS;
        else process.env.PROVIDER_ACCESS = prev;
      });

      it('read-only provider: models stay VISIBLE but available=false + access:read-only tag', async () => {
        process.env.PROVIDER_ACCESS = 'openmodel:read';
        service.register(openmodelConnector);
        service.register(cliConnector);
        // CONN-0245: assembly (READ/USE gate + tags) lives in
        // buildCatalogSnapshot() now — getCatalog() reads the DB. This is the
        // exact CONN-0244 assertion, retargeted at the function that still
        // does the assembly.
        const result = await assembleFiltered(service, noFilters);
        const om = result.filter((m) => m.connector === 'openmodel');
        expect(om.length).toBe(3); // still visible in the catalog
        expect(om.every((m) => m.available === false)).toBe(true); // not routable
        expect(om.every((m) => m.tags.includes('access:read-only'))).toBe(true);
        // a fully-enabled provider is unaffected
        const cli = result.filter((m) => m.connector === 'claude-code');
        expect(cli.every((m) => m.available === true)).toBe(true);
        expect(cli.some((m) => m.tags.includes('access:read-only'))).toBe(false);
      });

      it('hidden provider (none): models are absent from the catalog', async () => {
        process.env.PROVIDER_ACCESS = 'openmodel:none';
        service.register(openmodelConnector);
        service.register(cliConnector);
        const result = await assembleFiltered(service, noFilters);
        expect(result.some((m) => m.connector === 'openmodel')).toBe(false);
        expect(result.some((m) => m.connector === 'claude-code')).toBe(true);
      });

      it('canRead/canUse reflect the configured access level', () => {
        process.env.PROVIDER_ACCESS = 'openmodel:read';
        expect(service.canRead('openmodel')).toBe(true);
        expect(service.canUse('openmodel')).toBe(false);
        expect(service.canRead('gemini')).toBe(true); // unlisted → fully enabled
        expect(service.canUse('gemini')).toBe(true);
      });

      it('execute() on a read-only provider is rejected (provider_not_routable) with no outbound call', async () => {
        process.env.PROVIDER_ACCESS = 'openmodel:read';
        service.register(openmodelConnector);
        const res = await service.execute(
          'openmodel',
          { prompt: 'x', model: 'deepseek-v4-flash' },
          'key-1',
        );
        expect(res.status).toBe('error');
        expect(res.error?.type).toBe('provider_not_routable');
        expect(openmodelConnector.execute).not.toHaveBeenCalled();
      });
    });

    it('sets free=false for openmodel deepseek-r2 (price_multiplier=1)', async () => {
      service.register(openmodelConnector);
      const result = await assembleFiltered(service, noFilters);
      const r2 = result.find((m) => m.model === 'deepseek-r2');
      expect(r2?.free).toBe(false);
      expect(r2?.cheap).toBe(true); // price_multiplier=1 = cheap
      expect(r2?.priceMultiplier).toBe(1);
    });

    it('sets priceMultiplier=null for connectors without catalogue data', async () => {
      service.register(cliConnector);
      const result = await assembleFiltered(service, noFilters);
      for (const m of result) {
        expect(m.priceMultiplier).toBeNull();
      }
    });

    it('sets rateLimits=null for all models (no connector exposes RPM/TPM)', async () => {
      service.register(openmodelConnector);
      const result = await assembleFiltered(service, noFilters);
      for (const m of result) {
        expect(m.rateLimits).toBeNull();
      }
    });

    it('free filter: returns only free models', async () => {
      service.register(openmodelConnector);
      service.register(cliConnector);
      service.register(freeProviderConnector); // openmodel is paid now — use a genuinely-free provider
      const result = await assembleFiltered(service, { ...noFilters, free: true });
      expect(result.every((m) => m.free)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      // and none of the free results are openmodel
      expect(result.some((m) => m.connector === 'openmodel')).toBe(false);
    });

    it('cheap filter: returns free and low-cost models', async () => {
      service.register(openmodelConnector);
      const result = await assembleFiltered(service, { ...noFilters, cheap: true });
      expect(result.every((m) => m.cheap)).toBe(true);
      // deepseek-v4-flash (free) + deepseek-r2 (multiplier=1) qualify; qwen3-235b (multiplier=1) qualifies too
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('capability filter supportsTools: excludes openmodel (supportsTools=false)', async () => {
      service.register(openmodelConnector);
      service.register(cliConnector);
      const result = await assembleFiltered(service, { ...noFilters, capability: 'supportsTools' });
      expect(result.every((m) => m.connector === 'claude-code')).toBe(true);
    });

    it('capability filter supportsJsonSchema: includes openmodel and claude-code', async () => {
      service.register(openmodelConnector);
      service.register(cliConnector);
      const result = await assembleFiltered(service, {
        ...noFilters,
        capability: 'supportsJsonSchema',
      });
      const connectors = new Set(result.map((m) => m.connector));
      expect(connectors).toContain('openmodel');
      expect(connectors).toContain('claude-code');
    });

    it('routing field matches connector name and model id', async () => {
      service.register(openmodelConnector);
      const result = await assembleFiltered(service, noFilters);
      for (const m of result) {
        expect(m.routing.connector).toBe(m.connector);
        expect(m.routing.model).toBe(m.model);
      }
    });

    it('available reflects connector health status', async () => {
      const unhealthyConnector: IConnector = {
        ...cliConnector,
        name: 'unhealthy',
        getStatus: vi.fn().mockResolvedValue({
          name: 'unhealthy',
          healthy: false,
          activeJobs: 0,
          queuedJobs: 0,
          rateLimitStatus: 'ok',
        }),
      };
      service.register(unhealthyConnector);
      const result = await assembleFiltered(service, noFilters);
      expect(result.every((m) => m.available === false)).toBe(true);
    });

    it('CONN-0244: one open per-model breaker offlines ONLY that model, not the whole connector', async () => {
      // Regression: an open per-model breaker used to flip the connector `healthy=false`
      // (via aggregate) and blanket-offline every model. Now `healthy` = reachable, and
      // only the model whose breaker is open is `available:false`.
      const partiallyDegraded: IConnector = {
        ...openmodelConnector,
        name: 'openrouter',
        getStatus: vi.fn().mockResolvedValue({
          name: 'openrouter',
          healthy: true, // reachable
          activeJobs: 0,
          queuedJobs: 0,
          rateLimitStatus: 'ok',
          circuitBreakers: {
            'deepseek-r2': { state: 'open', consecutiveFailures: 5, lastErrorType: 'rate_limited' },
          },
        }),
        getCapabilities: vi.fn().mockReturnValue({
          name: 'openrouter',
          type: 'api',
          models: ['deepseek-v4-flash', 'deepseek-r2', 'qwen3-235b'],
          supportsStreaming: false,
          supportsJsonSchema: true,
          supportsTools: false,
          maxTimeout: 120_000,
          freeModels: ['deepseek-v4-flash'],
        }),
      };
      service.register(partiallyDegraded);
      const result = await assembleFiltered(service, noFilters);
      const byId = (id: string) => result.find((m) => m.model === id);
      expect(byId('deepseek-r2')?.available).toBe(false); // open breaker → offline
      expect(byId('deepseek-v4-flash')?.available).toBe(true); // healthy → online
      expect(byId('qwen3-235b')?.available).toBe(true); // healthy → online
    });

    it('getStatus failure is handled gracefully (available=false)', async () => {
      const failingStatusConnector: IConnector = {
        ...cliConnector,
        name: 'failing-status',
        getStatus: vi.fn().mockRejectedValue(new Error('binary not found')),
      };
      service.register(failingStatusConnector);
      const result = await assembleFiltered(service, noFilters);
      const failModels = result.filter((m) => m.connector === 'failing-status');
      expect(failModels.every((m) => m.available === false)).toBe(true);
    });

    it('capabilities field mirrors connector caps', async () => {
      service.register(openmodelConnector);
      const result = await assembleFiltered(service, noFilters);
      for (const m of result) {
        expect(m.capabilities.supportsJsonSchema).toBe(true);
        expect(m.capabilities.supportsStreaming).toBe(false);
        expect(m.capabilities.supportsTools).toBe(false);
      }
    });

    // ── CONN-0232: modality + derived tags on chat connectors ──
    it('stamps modality=chat by default and modality:* + cost/cap tags', async () => {
      service.register(openmodelConnector);
      const result = await assembleFiltered(service, noFilters);
      const flash = result.find((m) => m.model === 'deepseek-v4-flash');
      expect(flash?.modality).toBe('chat');
      expect(flash?.tags).toContain('modality:chat');
      expect(flash?.tags).toContain('cost:cheap'); // CONN-0244: paid gateway → cheap, not free
      expect(flash?.tags).not.toContain('cost:free');
      expect(flash?.tags).toContain('cap:json-schema');
      expect(flash?.tags).not.toContain('cap:tools'); // openmodel supportsTools=false
    });

    it('uses the connector-declared modality when present (embedding)', async () => {
      const embeddingConnector: IConnector = {
        ...cliConnector,
        name: 'embedding',
        getCapabilities: vi.fn().mockReturnValue({
          name: 'embedding',
          type: 'api',
          modality: 'embedding',
          models: ['bge-m3'],
          supportsStreaming: false,
          supportsJsonSchema: false,
          supportsTools: false,
          maxTimeout: 60_000,
        }),
      };
      service.register(embeddingConnector);
      const result = await assembleFiltered(service, noFilters);
      const bge = result.find((m) => m.model === 'bge-m3');
      expect(bge?.modality).toBe('embedding');
      expect(bge?.tags).toContain('modality:embedding');
    });

    it('?modality= filter narrows to a single family', async () => {
      service.register(openmodelConnector);
      const result = await assembleFiltered(service, { ...noFilters, modality: 'embedding' });
      expect(result).toHaveLength(0); // openmodel is chat
      const chat = await assembleFiltered(service, { ...noFilters, modality: 'chat' });
      expect(chat.length).toBeGreaterThan(0);
    });

    it('?connector= filter narrows to one connector', async () => {
      service.register(openmodelConnector);
      service.register(cliConnector);
      const result = await assembleFiltered(service, { ...noFilters, connector: 'claude-code' });
      expect(result.every((m) => m.connector === 'claude-code')).toBe(true);
      expect(result.length).toBe(2);
    });

    it('?tag= and ?group= filters work', async () => {
      service.register(openmodelConnector);
      const byTag = await assembleFiltered(service, { ...noFilters, tag: 'cost:free' });
      expect(byTag.every((m) => m.tags.includes('cost:free'))).toBe(true);
      const byGroup = await assembleFiltered(service, { ...noFilters, group: 'cost' });
      expect(byGroup.every((m) => m.tags.some((t) => t.startsWith('cost:')))).toBe(true);
    });

    // ── CONN-0232 R10: per-model availability ──
    it('R10: a reachable connector keeps models available even if a /health route would 404', async () => {
      // healthy:true models stay available; this asserts the per-model path does
      // not blanket-offline when the connector is reachable.
      service.register(openmodelConnector);
      const result = await assembleFiltered(service, noFilters);
      expect(result.every((m) => m.available === true)).toBe(true);
    });

    it('R10: only the model whose circuit breaker is OPEN is unavailable, not its siblings', async () => {
      const partiallyDegraded: IConnector = {
        ...openmodelConnector,
        name: 'openmodel',
        getStatus: vi.fn().mockResolvedValue({
          name: 'openmodel',
          healthy: true,
          activeJobs: 0,
          queuedJobs: 0,
          rateLimitStatus: 'ok',
          circuitBreakers: {
            'deepseek-r2': {
              state: 'open',
              consecutiveFailures: 5,
              lastErrorType: 'server_error',
            },
          },
        }),
      };
      service.register(partiallyDegraded);
      const result = await assembleFiltered(service, noFilters);
      const r2 = result.find((m) => m.model === 'deepseek-r2');
      const flash = result.find((m) => m.model === 'deepseek-v4-flash');
      expect(r2?.available).toBe(false); // its breaker is open
      expect(flash?.available).toBe(true); // sibling unaffected
    });

    // ── CONN-0238: per-model modality + pricing/context + honest non-chat presentation ──
    const multiModalConnector: IConnector = {
      name: 'groq',
      type: 'api',
      execute: vi.fn(),
      getStatus: vi.fn().mockResolvedValue({
        name: 'groq',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      }),
      getCapabilities: vi.fn().mockReturnValue({
        name: 'groq',
        type: 'api',
        supportsStreaming: false,
        supportsJsonSchema: true,
        supportsTools: true,
        maxTimeout: 300_000,
        models: ['llama-3.3-70b-versatile', 'whisper-large-v3', 'orpheus-x', 'prompt-guard-x'],
        freeModels: ['llama-3.3-70b-versatile', 'prompt-guard-x'],
        modelMeta: [
          {
            id: 'llama-3.3-70b-versatile',
            modality: 'chat',
            free: true,
            pricing: { inputPerMTok: 0.59, outputPerMTok: 0.79, unit: 'per_1m_tokens' },
            contextWindow: 131072,
            maxOutputTokens: 32768,
          },
          { id: 'whisper-large-v3', modality: 'speech_to_text', free: false, pricing: null },
          { id: 'orpheus-x', modality: 'text_to_speech', free: false, pricing: null },
          { id: 'prompt-guard-x', modality: 'moderation', free: true, pricing: null },
        ],
      }),
      resetCircuitBreaker: vi.fn().mockReturnValue([]),
    };

    const grokImagineConnector: IConnector = {
      ...multiModalConnector,
      name: 'grok',
      getStatus: vi.fn().mockResolvedValue({
        name: 'grok',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      }),
      getCapabilities: vi.fn().mockReturnValue({
        name: 'grok',
        type: 'api',
        supportsStreaming: false,
        supportsJsonSchema: true,
        supportsTools: true,
        maxTimeout: 300_000,
        models: ['grok-4.3', 'grok-imagine-image', 'grok-imagine-video'],
        freeModels: [],
        modelMeta: [
          { id: 'grok-4.3', modality: 'chat', free: false },
          { id: 'grok-imagine-image', modality: 'image_generation', free: false },
          { id: 'grok-imagine-video', modality: 'video', free: false },
        ],
      }),
    };

    const find = (r: CatalogModelEntry[], id: string) => r.find((m) => m.model === id)!;

    it('stamps per-model modality from modelMeta (one connector, many modalities)', async () => {
      service.register(multiModalConnector);
      const r = await assembleFiltered(service, noFilters);
      expect(find(r, 'llama-3.3-70b-versatile').modality).toBe('chat');
      expect(find(r, 'whisper-large-v3').modality).toBe('speech_to_text');
      expect(find(r, 'orpheus-x').modality).toBe('text_to_speech');
      expect(find(r, 'prompt-guard-x').modality).toBe('moderation');
    });

    it('surfaces real pricing + context + maxOutputTokens from modelMeta', async () => {
      service.register(multiModalConnector);
      const r = await assembleFiltered(service, noFilters);
      const m = find(r, 'llama-3.3-70b-versatile');
      expect(m.pricing).toEqual({ inputPerMTok: 0.59, outputPerMTok: 0.79, unit: 'per_1m_tokens' });
      expect(m.contextWindow).toBe(131072);
      expect(m.maxOutputTokens).toBe(32768);
    });

    it('keeps pricing/context null where modelMeta has none', async () => {
      service.register(multiModalConnector);
      const r = await assembleFiltered(service, noFilters);
      const w = find(r, 'whisper-large-v3');
      expect(w.pricing).toBeNull();
      expect(w.contextWindow).toBeNull();
    });

    it('non-chat families on a chat connector are NOT claimed callable (available=false, NO chat caps, no misleading endpoint)', async () => {
      service.register(multiModalConnector);
      const r = await assembleFiltered(service, noFilters);
      const w = find(r, 'whisper-large-v3');
      expect(w.available).toBe(false);
      expect(w.capabilities).toEqual({
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
      });
      // No endpoint — the (groq, whisper) tuple is not a real route here; the
      // executable STT row is the dedicated `groq-stt` connector. available:false
      // + modality is the honest signal.
      expect(w.routing.endpoint).toBeUndefined();
      expect(find(r, 'orpheus-x').routing.endpoint).toBeUndefined();
    });

    it('chat stays available + carries chat caps; moderation is callable but caps-masked', async () => {
      service.register(multiModalConnector);
      const r = await assembleFiltered(service, noFilters);
      const chat = find(r, 'llama-3.3-70b-versatile');
      const mod = find(r, 'prompt-guard-x');
      expect(chat.available).toBe(true);
      expect(chat.capabilities.supportsTools).toBe(true);
      expect(mod.available).toBe(true); // groq prompt-guard is served via chat/completions
      expect(mod.capabilities.supportsTools).toBe(false); // classifier — no tools/json/streaming
      expect(mod.routing.endpoint).toBeUndefined(); // chat /execute path
    });

    it('per-model free flag from modelMeta (whisper not free, chat/moderation free)', async () => {
      service.register(multiModalConnector);
      const r = await assembleFiltered(service, noFilters);
      expect(find(r, 'llama-3.3-70b-versatile').free).toBe(true);
      expect(find(r, 'prompt-guard-x').free).toBe(true);
      expect(find(r, 'whisper-large-v3').free).toBe(false);
    });

    it('grok-imagine image/video are surfaced but available=false (MC cannot execute them)', async () => {
      service.register(grokImagineConnector);
      const r = await assembleFiltered(service, noFilters);
      const img = find(r, 'grok-imagine-image');
      const vid = find(r, 'grok-imagine-video');
      expect(img.modality).toBe('image_generation');
      expect(img.available).toBe(false);
      expect(img.routing.endpoint).toBeUndefined(); // grok-imagine not wired in MC image module
      expect(vid.modality).toBe('video');
      expect(vid.available).toBe(false);
      expect(vid.routing.endpoint).toBeUndefined(); // no MC video execute route
      // the chat sibling stays callable
      expect(find(r, 'grok-4.3').available).toBe(true);
    });

    it('?modality=video filter narrows to grok-imagine-video', async () => {
      service.register(grokImagineConnector);
      const r = await assembleFiltered(service, { ...noFilters, modality: 'video' });
      expect(r.map((m) => m.model)).toEqual(['grok-imagine-video']);
    });
  });
  // ── CONN-0232: catalog completeness via the real ModalityCatalogService ──
  describe('buildCatalogSnapshot completeness (CONN-0232 WS3)', () => {
    const noFilters: CatalogFilters = { free: false, cheap: false, capability: undefined };
    let fullService: ConnectorsService;

    beforeEach(async () => {
      const { ModalityCatalogService } = await import('./modality-catalog.service');
      fullService = new ConnectorsService(
        mockQueue as unknown as Queue,
        mockPrisma as unknown as PrismaService,
        mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
        new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
        new ModalityCatalogService(),
      );
    });

    it('surfaces image-generation, speech-to-text and text-to-speech families', async () => {
      const result = await assembleFiltered(fullService, noFilters);
      const modalities = new Set(result.map((m) => m.modality));
      expect(modalities).toContain('image_generation');
      expect(modalities).toContain('speech_to_text');
      expect(modalities).toContain('text_to_speech');
    });

    it('non-chat entries carry an honest routing.endpoint (not the chat /execute route)', async () => {
      const result = await assembleFiltered(fullService, noFilters);
      const img = result.find((m) => m.modality === 'image_generation');
      const stt = result.find((m) => m.modality === 'speech_to_text');
      const tts = result.find((m) => m.modality === 'text_to_speech');
      expect(img?.routing.endpoint).toBe('/images/generate');
      expect(stt?.routing.endpoint).toBe('/v1/speech/stt');
      expect(tts?.routing.endpoint).toBe('/v1/speech/tts');
    });

    it('?modality=image_generation returns only image-gen models', async () => {
      const result = await assembleFiltered(fullService, {
        ...noFilters,
        modality: 'image_generation',
      });
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((m) => m.modality === 'image_generation')).toBe(true);
    });

    it('emits zero rerank entries (reserved modality, no connector yet — anti-fabrication)', async () => {
      const result = await assembleFiltered(fullService, { ...noFilters, modality: 'rerank' });
      expect(result).toHaveLength(0);
    });
  });

  // ── CONN-0245: getCatalog() DB read path — reads ONLY the repo (+ cache), ──
  // ── never a provider. This is the actual request-path contract now.      ──
  describe('getCatalog DB read path (CONN-0245)', () => {
    const noFilters: CatalogFilters = { free: false, cheap: false, capability: undefined };

    function makeChatEntry(overrides: Partial<CatalogModelEntry> = {}): CatalogModelEntry {
      return {
        connector: 'groq',
        model: 'llama-3.3-70b-versatile',
        modality: 'chat',
        tags: ['modality:chat', 'cost:free'],
        free: true,
        cheap: true,
        priceMultiplier: null,
        rateLimits: null,
        pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'per_1m_tokens' },
        contextWindow: 131072,
        maxOutputTokens: 32768,
        capabilities: { supportsStreaming: false, supportsJsonSchema: true, supportsTools: true },
        routing: { connector: 'groq', model: 'llama-3.3-70b-versatile' },
        routable: true,
        available: true,
        ...overrides,
      };
    }

    it('reads from the repo and maps rows to CatalogModelEntry[] — does NOT call any connector', async () => {
      const connector = {
        name: 'groq',
        type: 'api',
        execute: vi.fn(),
        getStatus: vi.fn(),
        getCapabilities: vi.fn(),
        resetCircuitBreaker: vi.fn(),
      } as unknown as IConnector;
      const dbService = new ConnectorsService(
        mockQueue as unknown as Queue,
        mockPrisma as unknown as PrismaService,
        mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
        new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
        emptyModalityCatalog,
        repoFromEntries([makeChatEntry()]),
        null,
      );
      dbService.register(connector);

      const result = await dbService.getCatalog(noFilters);

      expect(result.models).toHaveLength(1);
      expect(result.models[0]).toMatchObject({
        connector: 'groq',
        model: 'llama-3.3-70b-versatile',
        modality: 'chat',
        free: true,
        available: true,
      });
      expect(result.count).toBe(1);
      expect(connector.getStatus).not.toHaveBeenCalled();
      expect(connector.execute).not.toHaveBeenCalled();
      expect(connector.getCapabilities).not.toHaveBeenCalled();
    });

    it('applies filters against the mapped rows (same entryMatchesFilters semantics)', async () => {
      const repo = repoFromEntries([
        makeChatEntry(),
        makeChatEntry({
          model: 'whisper-large-v3',
          modality: 'speech_to_text',
          free: false,
          cheap: false,
          pricing: null,
          tags: ['modality:speech_to_text'],
          capabilities: {
            supportsStreaming: false,
            supportsJsonSchema: false,
            supportsTools: false,
          },
          routing: { connector: 'groq', model: 'whisper-large-v3', endpoint: '/v1/speech/stt' },
        }),
      ]);
      const dbService = new ConnectorsService(
        mockQueue as unknown as Queue,
        mockPrisma as unknown as PrismaService,
        mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
        new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
        emptyModalityCatalog,
        repo,
        null,
      );

      const chatOnly = await dbService.getCatalog({ ...noFilters, modality: 'chat' });
      expect(chatOnly.models.map((m) => m.model)).toEqual(['llama-3.3-70b-versatile']);

      const sttOnly = await dbService.getCatalog({ ...noFilters, modality: 'speech_to_text' });
      expect(sttOnly.models.map((m) => m.model)).toEqual(['whisper-large-v3']);
      expect(sttOnly.models[0].routing.endpoint).toBe('/v1/speech/stt');
    });

    it("excludes absent rows (findAll is the repo's job — service just trusts it)", async () => {
      const repo = repoFromEntries([makeChatEntry()]); // repoFromEntries always sets absent:false
      const dbService = new ConnectorsService(
        mockQueue as unknown as Queue,
        mockPrisma as unknown as PrismaService,
        mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
        new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
        emptyModalityCatalog,
        repo,
        null,
      );
      const result = await dbService.getCatalog(noFilters);
      expect(result.models).toHaveLength(1);
      expect(repo.findAll).toHaveBeenCalledTimes(1);
    });

    it('returns generatedAt as a valid ISO-8601 string derived from row.lastChecked', async () => {
      const dbService = new ConnectorsService(
        mockQueue as unknown as Queue,
        mockPrisma as unknown as PrismaService,
        mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
        new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
        emptyModalityCatalog,
        repoFromEntries([makeChatEntry()]),
        null,
      );
      const result = await dbService.getCatalog(noFilters);
      expect(() => new Date(result.generatedAt)).not.toThrow();
      expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
    });

    it('count matches models array length', async () => {
      const dbService = new ConnectorsService(
        mockQueue as unknown as Queue,
        mockPrisma as unknown as PrismaService,
        mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
        new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
        emptyModalityCatalog,
        repoFromEntries([makeChatEntry(), makeChatEntry({ model: 'm2' })]),
        null,
      );
      const result = await dbService.getCatalog(noFilters);
      expect(result.count).toBe(result.models.length);
    });

    it('cache hit: returns the cached envelope WITHOUT calling the repo', async () => {
      const cachedResponse = {
        models: [makeChatEntry()],
        generatedAt: '2026-07-05T16:00:00.000Z',
        count: 1,
      };
      const repo = repoFromEntries([]); // would return empty if actually queried
      const redis: ICatalogRedis = {
        get: vi.fn().mockResolvedValue(JSON.stringify(cachedResponse)),
        set: vi.fn(),
        del: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
      };
      const dbService = new ConnectorsService(
        mockQueue as unknown as Queue,
        mockPrisma as unknown as PrismaService,
        mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
        new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
        emptyModalityCatalog,
        repo,
        redis,
      );

      const result = await dbService.getCatalog(noFilters);

      expect(result).toEqual(cachedResponse);
      expect(repo.findAll).not.toHaveBeenCalled();
    });

    it('cache miss: reads the repo and stores the result in the cache', async () => {
      const repo = repoFromEntries([makeChatEntry()]);
      const redis: ICatalogRedis = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn(),
        keys: vi.fn().mockResolvedValue([]),
      };
      const dbService = new ConnectorsService(
        mockQueue as unknown as Queue,
        mockPrisma as unknown as PrismaService,
        mockMetrics as unknown as import('../metrics/metrics.service').MetricsService,
        new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
        emptyModalityCatalog,
        repo,
        redis,
      );

      const result = await dbService.getCatalog(noFilters);

      expect(repo.findAll).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, value, mode] = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(key).toMatch(/^conn:catalog:/);
      expect(JSON.parse(value)).toMatchObject({ count: result.count });
      expect(mode).toBe('PX');
    });
  });

  // CONN-0089 ------------------------------------------------------------------
  describe('output-guard integration (CONN-0089)', () => {
    function jsonConnector(result: string): IConnector {
      return {
        ...mockConnector,
        execute: vi.fn().mockResolvedValue({
          id: 'r-og',
          connector: 'test',
          model: 'model',
          result,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
          latencyMs: 10,
          status: 'success',
        }),
      } as IConnector;
    }

    it('omits repair_report when output_format is absent (V-AC-3 byte-compat)', async () => {
      service.register(mockConnector);
      const result = await service.execute('test', { prompt: 'hello' }, 'key-1');
      expect(result.repair_report).toBeUndefined();
    });

    it('attaches repair_report when output_format=json (V-AC-2)', async () => {
      const conn = jsonConnector('{"name":"x","value":1}');
      service.register(conn);
      const result = await service.execute(
        'test',
        {
          prompt: 'hello',
          output_format: 'json',
          schema: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'number' } },
            required: ['name', 'value'],
          },
        },
        'key-1',
      );
      expect(result.repair_report).toBeDefined();
      expect(result.repair_report?.final_valid).toBe(true);
    });

    it('does NOT outer-retry on guard_exhausted (orthogonality)', async () => {
      const conn = jsonConnector('this is "text" with stuff'); // forces ParseError chain
      service.register(conn);
      const result = await service.execute(
        'test',
        {
          prompt: 'hello',
          output_format: 'json',
          schema: { type: 'object', required: ['x'] },
        },
        'key-1',
      );
      expect(result.repair_report?.pass).toBe('failed');
      expect(result.error?.type).toBe('guard_exhausted');
      // Middleware itself calls connector.execute (maxRetries+1) times. Outer
      // ConnectorsService retry loop must NOT add another call on top.
      // Default OUTPUT_GUARD_MAX_RETRIES=3 → 4 calls. CONNECTOR_MAX_RETRIES=1
      // would add another 4 calls if outer retry kicked in (we'd see ≥5).
      expect((conn.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(4);
    });
  });
});

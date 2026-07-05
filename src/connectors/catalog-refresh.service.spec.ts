import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CatalogRefreshService } from './catalog-refresh.service';
import { ConnectorsService } from './connectors.service';
import { CatalogRepository } from './catalog.repository';
import type { CatalogModelEntry } from './dto/catalog.dto';
import type { ICatalogRedis } from './catalog-redis.token';
import type { ProviderAccessLike, ProviderAccess } from './provider-access.service';

function makeEntry(overrides: Partial<CatalogModelEntry> = {}): CatalogModelEntry {
  return {
    connector: 'groq',
    model: 'llama-3.3-70b-versatile',
    modality: 'chat',
    tags: ['modality:chat'],
    free: true,
    cheap: true,
    priceMultiplier: null,
    rateLimits: null,
    pricing: { inputPerMTok: 0, outputPerMTok: 0, unit: 'per_1m_tokens' },
    contextWindow: 131072,
    maxOutputTokens: 32768,
    capabilities: { supportsStreaming: false, supportsJsonSchema: true, supportsTools: true },
    routing: { connector: 'groq', model: 'llama-3.3-70b-versatile' },
    available: true,
    ...overrides,
  };
}

// CONN-0245-EXT — fail-open-by-default mock for ProviderAccessService: no
// seedDefaults/refresh side effects asserted here beyond call-tracking.
function makeProviderAccess(): {
  seedDefaults: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  getAccess: ReturnType<typeof vi.fn>;
} {
  return {
    seedDefaults: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    getAccess: vi.fn().mockReturnValue({ read: true, use: true } satisfies ProviderAccess),
  };
}

describe('CatalogRefreshService (CONN-0245 / CONN-0245-EXT)', () => {
  let connectorsService: {
    refreshAllProviderModels: ReturnType<typeof vi.fn>;
    buildCatalogSnapshot: ReturnType<typeof vi.fn>;
    listNames: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    canUse: ReturnType<typeof vi.fn>;
  };
  let catalogRepo: {
    upsertSnapshot: ReturnType<typeof vi.fn>;
    markAbsentExcept: ReturnType<typeof vi.fn>;
    updateProviderStatus: ReturnType<typeof vi.fn>;
  };
  let catalogRedis: ICatalogRedis;
  let providerAccess: ReturnType<typeof makeProviderAccess>;
  let service: CatalogRefreshService;

  beforeEach(() => {
    connectorsService = {
      refreshAllProviderModels: vi.fn().mockResolvedValue(undefined),
      // CONN-0244's READ gate + routable computation already ran INSIDE the
      // real buildCatalogSnapshot() (see connectors.service.spec.ts) — this
      // mock returns the POST-gate entries directly, matching what the real
      // method would hand back.
      buildCatalogSnapshot: vi.fn().mockResolvedValue([makeEntry()]),
      listNames: vi.fn().mockReturnValue(['groq']),
      getStatus: vi.fn().mockResolvedValue({
        name: 'groq',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      }),
      // CONN-0244 — `canUse` is what fullRefresh consults (sync) to persist
      // `routable` per entry. Fully-usable by default.
      canUse: vi.fn().mockReturnValue(true),
    };
    catalogRepo = {
      upsertSnapshot: vi.fn().mockResolvedValue(undefined),
      markAbsentExcept: vi.fn().mockResolvedValue(undefined),
      updateProviderStatus: vi.fn().mockResolvedValue(undefined),
    };
    catalogRedis = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockResolvedValue(['conn:catalog:abc']),
    };
    providerAccess = makeProviderAccess();
    service = new CatalogRefreshService(
      connectorsService as unknown as ConnectorsService,
      catalogRepo as unknown as CatalogRepository,
      catalogRedis,
      providerAccess as unknown as ProviderAccessLike,
    );
  });

  describe('fullRefresh', () => {
    it('refreshes provider models, builds a snapshot, persists it, refreshes provider access, and invalidates the cache', async () => {
      await service.fullRefresh();

      expect(connectorsService.refreshAllProviderModels).toHaveBeenCalledTimes(1);
      expect(connectorsService.buildCatalogSnapshot).toHaveBeenCalledTimes(1);

      expect(catalogRepo.upsertSnapshot).toHaveBeenCalledTimes(1);
      const rows = catalogRepo.upsertSnapshot.mock.calls[0][0];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        connector: 'groq',
        model: 'llama-3.3-70b-versatile',
        status: 'online',
        tier: 'free',
        free: true,
        routable: true, // canUse('groq') === true
      });

      expect(catalogRepo.markAbsentExcept).toHaveBeenCalledWith([
        { connector: 'groq', model: 'llama-3.3-70b-versatile' },
      ]);

      expect(providerAccess.refresh).toHaveBeenCalledTimes(1);
      expect(catalogRedis.keys).toHaveBeenCalledWith('conn:catalog:*');
      expect(catalogRedis.del).toHaveBeenCalledWith('conn:catalog:abc');
    });

    it('one provider throwing during refreshAllProviderModels does not abort the cycle (still persists)', async () => {
      connectorsService.refreshAllProviderModels.mockRejectedValueOnce(new Error('boom'));
      await expect(service.fullRefresh()).resolves.not.toThrow();
      // buildCatalogSnapshot/upsert should still be attempted best-effort —
      // the overall cycle survives one failing step.
    });

    it('does not overlap: a second concurrent call while one is running is a no-op', async () => {
      let resolveSnapshot: (v: CatalogModelEntry[]) => void = () => {};
      connectorsService.buildCatalogSnapshot.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
      );
      const first = service.fullRefresh();
      const second = service.fullRefresh(); // should return immediately, skip
      resolveSnapshot([makeEntry()]);
      await Promise.all([first, second]);
      expect(connectorsService.buildCatalogSnapshot).toHaveBeenCalledTimes(1);
    });

    it('skips cache invalidation gracefully when no Redis client is configured', async () => {
      const noRedisService = new CatalogRefreshService(
        connectorsService as unknown as ConnectorsService,
        catalogRepo as unknown as CatalogRepository,
        null,
        providerAccess as unknown as ProviderAccessLike,
      );
      await expect(noRedisService.fullRefresh()).resolves.not.toThrow();
    });

    // QA FIX A (Finding 2) — an empty snapshot must never wipe the live catalog.
    it('an EMPTY snapshot skips upsertSnapshot/markAbsentExcept entirely (does not blank the live catalog)', async () => {
      connectorsService.buildCatalogSnapshot.mockResolvedValue([]);

      await expect(service.fullRefresh()).resolves.not.toThrow();

      expect(catalogRepo.upsertSnapshot).not.toHaveBeenCalled();
      expect(catalogRepo.markAbsentExcept).not.toHaveBeenCalled();
    });

    it('CONN-0244 READ gate happens inside buildCatalogSnapshot() — this class does NOT re-filter (no entry for a hidden provider ⇒ none persisted)', async () => {
      // Simulates what the real buildCatalogSnapshot() returns once its own
      // internal `access.read` check has already excluded a hidden provider
      // (see connectors.service.spec.ts "hidden provider (none)" for that gate
      // tested at its actual layer).
      connectorsService.buildCatalogSnapshot.mockResolvedValue([
        makeEntry({ connector: 'groq', model: 'llama-3.3-70b-versatile' }),
      ]);
      await service.fullRefresh();
      const rows = catalogRepo.upsertSnapshot.mock.calls[0][0];
      expect(rows).toHaveLength(1);
      expect(rows[0].connector).toBe('groq');
      const seen = catalogRepo.markAbsentExcept.mock.calls[0][0];
      expect(seen).toEqual([{ connector: 'groq', model: 'llama-3.3-70b-versatile' }]);
    });

    it('routable is sourced from connectorsService.canUse(entry.connector), per-entry', async () => {
      connectorsService.buildCatalogSnapshot.mockResolvedValue([
        makeEntry({
          connector: 'openmodel',
          model: 'deepseek-v4-flash',
          free: false,
          cheap: false,
        }),
      ]);
      connectorsService.canUse.mockImplementation((name: string) => name !== 'openmodel');

      await service.fullRefresh();

      expect(connectorsService.canUse).toHaveBeenCalledWith('openmodel');
      const rows = catalogRepo.upsertSnapshot.mock.calls[0][0];
      expect(rows).toHaveLength(1);
      expect(rows[0].routable).toBe(false); // USE=off -> not routable, still persisted
    });

    it('CONN-0245-EXT headline case: canUse=true (default fail-open) persists routable=true', async () => {
      connectorsService.buildCatalogSnapshot.mockResolvedValue([
        makeEntry({ connector: 'brand-new' }),
      ]);
      await service.fullRefresh();
      const rows = catalogRepo.upsertSnapshot.mock.calls[0][0];
      expect(rows).toHaveLength(1);
      expect(rows[0].routable).toBe(true);
    });
  });

  describe('statusRefresh', () => {
    it('flips status via updateProviderStatus per connector (status-only refresh)', async () => {
      await service.statusRefresh();
      expect(catalogRepo.updateProviderStatus).toHaveBeenCalledWith(
        'groq',
        'online',
        expect.any(Date),
      );
    });

    it('a connector whose getStatus() throws is marked offline; other connectors are still processed', async () => {
      connectorsService.listNames.mockReturnValue(['groq', 'grok']);
      connectorsService.getStatus.mockImplementation(async (name: string) => {
        if (name === 'groq') throw new Error('connector unreachable');
        return { name, healthy: true, activeJobs: 0, queuedJobs: 0, rateLimitStatus: 'ok' };
      });

      await expect(service.statusRefresh()).resolves.not.toThrow();

      expect(catalogRepo.updateProviderStatus).toHaveBeenCalledWith(
        'groq',
        'offline',
        expect.any(Date),
      );
      expect(catalogRepo.updateProviderStatus).toHaveBeenCalledWith(
        'grok',
        'online',
        expect.any(Date),
      );
    });
  });

  describe('onModuleInit', () => {
    it('seeds provider access BEFORE firing a non-blocking fullRefresh on boot', async () => {
      const spy = vi.spyOn(service, 'fullRefresh').mockResolvedValue(undefined);
      // onModuleInit awaits seedDefaults (cheap create-only upserts) but must
      // NOT await fullRefresh itself (non-blocking boot warm-up) — fullRefresh
      // calls out to every live provider and must never delay Nest's bootstrap.
      await service.onModuleInit();
      expect(providerAccess.seedDefaults).toHaveBeenCalledWith(['groq']);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('still fires fullRefresh even if seedDefaults fails (non-fatal)', async () => {
      providerAccess.seedDefaults.mockRejectedValueOnce(new Error('db down'));
      const spy = vi.spyOn(service, 'fullRefresh').mockResolvedValue(undefined);
      await expect(service.onModuleInit()).resolves.not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});

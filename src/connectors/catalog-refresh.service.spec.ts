import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CatalogSnapshotConflictError,
  type ApplyProviderSnapshotInput,
} from './catalog.repository';
import { CatalogRefreshService } from './catalog-refresh.service';
import type { CatalogModelEntry } from './dto/catalog.dto';
import type { CatalogRefreshResult } from './interfaces/connector.interface';

function entry(
  connector: string,
  model: string,
  overrides: Partial<CatalogModelEntry> = {},
): CatalogModelEntry {
  return {
    connector,
    model,
    modality: 'chat',
    tags: ['modality:chat'],
    free: false,
    cheap: false,
    priceMultiplier: null,
    rateLimits: null,
    pricing: null,
    contextWindow: null,
    maxOutputTokens: null,
    capabilities: {
      supportsStreaming: true,
      supportsJsonSchema: true,
      supportsTools: true,
    },
    routing: { connector, model },
    available: true,
    ...overrides,
  };
}

describe('CatalogRefreshService CONN-1646 provider-scoped cycles', () => {
  let refreshResults: Map<string, CatalogRefreshResult>;
  let entries: CatalogModelEntry[];
  let readAccess: Record<string, boolean>;
  let connectors: {
    refreshAllProviderModels: ReturnType<typeof vi.fn>;
    buildCatalogSnapshot: ReturnType<typeof vi.fn>;
    listNames: ReturnType<typeof vi.fn>;
    listDynamicCatalogProviderNames: ReturnType<typeof vi.fn>;
    canRead: ReturnType<typeof vi.fn>;
    canUse: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
  };
  let repository: {
    applyProviderSnapshot: ReturnType<typeof vi.fn>;
    markProviderStale: ReturnType<typeof vi.fn>;
    updateProviderStatus: ReturnType<typeof vi.fn>;
  };
  let providerAccess: {
    seedDefaults: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  };
  let redis: {
    keys: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let service: CatalogRefreshService;

  beforeEach(() => {
    refreshResults = new Map();
    entries = [];
    readAccess = {};
    connectors = {
      refreshAllProviderModels: vi.fn(async () => refreshResults),
      buildCatalogSnapshot: vi.fn(async () => entries),
      listNames: vi.fn(() => ['groq', 'openrouter']),
      listDynamicCatalogProviderNames: vi.fn(() => Array.from(refreshResults.keys())),
      canRead: vi.fn((name: string) => readAccess[name] ?? true),
      canUse: vi.fn(() => true),
      getStatus: vi.fn().mockResolvedValue({ healthy: true }),
    };
    repository = {
      applyProviderSnapshot: vi.fn().mockResolvedValue({
        snapshotId: 'snapshot-1',
        fingerprint: 'f'.repeat(64),
        rowCount: 1,
      }),
      markProviderStale: vi.fn().mockResolvedValue(2),
      updateProviderStatus: vi.fn().mockResolvedValue(undefined),
    };
    providerAccess = {
      seedDefaults: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    redis = {
      keys: vi.fn().mockResolvedValue([]),
      del: vi.fn().mockResolvedValue(0),
    };
    service = new CatalogRefreshService(
      connectors as never,
      repository as never,
      redis as never,
      providerAccess as never,
    );
  });

  it('preserves a failed provider while applying a successful provider authoritatively', async () => {
    const observedAt = new Date('2026-07-26T13:00:00.000Z');
    const checkedAt = new Date('2026-07-26T13:00:01.000Z');
    refreshResults.set('groq', {
      status: 'success',
      source: 'provider-api',
      observedAt,
    });
    refreshResults.set('openrouter', {
      status: 'failed',
      source: 'provider-api',
      checkedAt,
      reason: 'network',
    });
    entries = [entry('groq', 'live'), entry('openrouter', 'last-known-good')];

    await service.fullRefresh();

    expect(repository.applyProviderSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.applyProviderSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        connector: 'groq',
        source: 'provider-api',
        freshness: 'fresh',
        observedAt,
        authoritative: true,
      }),
    );
    expect(repository.markProviderStale).toHaveBeenCalledWith('openrouter', checkedAt);
  });

  it('does not relabel cached dynamic rows as a static floor after refresh failure', async () => {
    refreshResults.set('groq', {
      status: 'failed',
      source: 'provider-api',
      checkedAt: new Date('2026-07-26T13:00:00.000Z'),
      reason: 'empty',
    });
    // Assembly reads the connector's current cache. After a prior success this
    // is last-known dynamic data, not evidence of the immutable static floor.
    entries = [entry('groq', 'cached-dynamic-model')];
    repository.markProviderStale.mockResolvedValue(0);

    await service.fullRefresh();

    expect(repository.markProviderStale).toHaveBeenCalledWith('groq', expect.any(Date));
    expect(repository.applyProviderSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ connector: 'groq' }),
    );
  });

  it('does not infer static provenance when a dynamic provider result is missing', async () => {
    connectors.listNames.mockReturnValue(['groq']);
    connectors.listDynamicCatalogProviderNames.mockReturnValue(['groq']);
    entries = [entry('groq', 'cached-dynamic-model')];

    await service.fullRefresh();

    expect(repository.markProviderStale).toHaveBeenCalledWith('groq', expect.any(Date));
    expect(repository.applyProviderSnapshot).not.toHaveBeenCalled();
  });

  it('applies static registered and modality-only providers with distinct provenance', async () => {
    connectors.listNames.mockReturnValue(['static-api']);
    entries = [entry('static-api', 'model-a'), entry('image-generation', 'model-b')];

    await service.fullRefresh();

    const inputs = repository.applyProviderSnapshot.mock.calls.map(
      ([input]) => input as ApplyProviderSnapshotInput,
    );
    expect(inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connector: 'static-api',
          source: 'static-capabilities',
          freshness: 'static',
          authoritative: true,
        }),
        expect.objectContaining({
          connector: 'image-generation',
          source: 'static-modality-catalog',
          freshness: 'static',
          authoritative: true,
        }),
      ]),
    );
  });

  it('does not write a READ-disabled provider even if assembly accidentally contains it', async () => {
    readAccess.openrouter = false;
    entries = [entry('groq', 'visible'), entry('openrouter', 'hidden')];

    await service.fullRefresh();

    expect(repository.applyProviderSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.applyProviderSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ connector: 'groq' }),
    );
    expect(repository.markProviderStale).not.toHaveBeenCalledWith('openrouter', expect.any(Date));
  });

  it('treats a successful enumeration with no assembled rows as a gap, never a removal', async () => {
    const observedAt = new Date('2026-07-26T13:00:00.000Z');
    refreshResults.set('groq', {
      status: 'success',
      source: 'provider-api',
      observedAt,
    });
    entries = [];

    await service.fullRefresh();

    expect(repository.markProviderStale).toHaveBeenCalledWith('groq', observedAt);
    expect(repository.applyProviderSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ connector: 'groq' }),
    );
  });

  it('defers a conflicting provider and continues later provider applications', async () => {
    connectors.listNames.mockReturnValue(['a', 'b']);
    entries = [entry('a', 'one'), entry('b', 'two')];
    repository.applyProviderSnapshot
      .mockRejectedValueOnce(new CatalogSnapshotConflictError())
      .mockResolvedValueOnce({
        snapshotId: 'snapshot-b',
        fingerprint: 'f'.repeat(64),
        rowCount: 1,
      });

    await service.fullRefresh();

    expect(repository.applyProviderSnapshot).toHaveBeenCalledTimes(2);
    expect(repository.applyProviderSnapshot.mock.calls[1][0]).toMatchObject({
      connector: 'b',
    });
    expect(providerAccess.refresh).toHaveBeenCalledTimes(1);
    expect(redis.keys).toHaveBeenCalled();
  });

  it('seeds defaults before the non-blocking boot refresh', async () => {
    const refreshSpy = vi.spyOn(service, 'fullRefresh').mockResolvedValue(undefined);

    await service.onModuleInit();

    expect(providerAccess.seedDefaults).toHaveBeenCalledWith(['groq', 'openrouter']);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('retains status-only updates without touching catalog content', async () => {
    connectors.listNames.mockReturnValue(['groq']);

    await service.statusRefresh();

    expect(repository.updateProviderStatus).toHaveBeenCalledWith(
      'groq',
      'online',
      expect.any(Date),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import {
  CatalogRepository,
  CatalogSnapshotConflictError,
  CatalogSnapshotValidationError,
  type ModelCatalogRow,
  type ModelCatalogUpsert,
} from './catalog.repository';
import { fingerprintCatalogRow } from './catalog-snapshot';

function row(overrides: Partial<ModelCatalogUpsert> = {}): ModelCatalogUpsert {
  return {
    connector: 'groq',
    model: 'model-a',
    modality: 'chat',
    status: 'online',
    lastChecked: new Date('2026-07-26T12:00:00.000Z'),
    supportsStreaming: true,
    supportsJsonSchema: true,
    supportsTools: true,
    inputPerMTok: null,
    outputPerMTok: null,
    priceUnit: 'USD/1M tokens',
    tier: 'unknown',
    free: false,
    priceMultiplier: null,
    contextWindow: null,
    maxOutputTokens: null,
    endpoint: null,
    executableHere: true,
    routable: true,
    ...overrides,
  };
}

function persisted(overrides: Partial<ModelCatalogRow> = {}): ModelCatalogRow {
  const base = row(overrides);
  const observedAt = new Date('2026-07-25T12:00:00.000Z');
  return {
    ...base,
    id: 'row-1',
    firstSeen: observedAt,
    lastSeen: observedAt,
    absent: false,
    snapshotId: 'previous-snapshot',
    contentFingerprint: fingerprintCatalogRow(base),
    observedAt,
    source: 'provider-api',
    freshness: 'fresh',
    absentSince: null,
    createdAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
}

describe('CatalogRepository CONN-1646', () => {
  let transaction: {
    modelCatalog: {
      findMany: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    catalogSnapshot: { create: ReturnType<typeof vi.fn> };
    catalogDriftEvent: { createMany: ReturnType<typeof vi.fn> };
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    modelCatalog: {
      updateMany: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  let repository: CatalogRepository;

  beforeEach(() => {
    transaction = {
      modelCatalog: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      catalogSnapshot: {
        create: vi.fn().mockResolvedValue({ id: 'snapshot-1' }),
      },
      catalogDriftEvent: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
      modelCatalog: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    repository = new CatalogRepository(prisma as unknown as PrismaService);
  });

  it('rejects a connector mismatch before opening a transaction', async () => {
    const promise = repository.applyProviderSnapshot({
      connector: 'groq',
      rows: [row({ connector: 'openrouter' })],
      source: 'provider-api',
      freshness: 'fresh',
      observedAt: new Date('2026-07-26T13:00:00.000Z'),
      authoritative: true,
    });

    await expect(promise).rejects.toEqual(
      expect.objectContaining({
        name: 'CatalogSnapshotValidationError',
        code: 'CATALOG_SNAPSHOT_INVALID_INPUT',
        message: 'Catalog snapshot input is invalid',
      }),
    );
    await expect(promise).rejects.not.toHaveProperty('cause');
    expect(CatalogSnapshotValidationError).toBeDefined();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate provider model identities before opening a transaction', async () => {
    await expect(
      repository.applyProviderSnapshot({
        connector: 'groq',
        rows: [row({ model: 'duplicate' }), row({ model: 'duplicate' })],
        source: 'provider-api',
        freshness: 'fresh',
        observedAt: new Date('2026-07-26T13:00:00.000Z'),
        authoritative: true,
      }),
    ).rejects.toMatchObject({
      name: 'CatalogSnapshotValidationError',
      code: 'CATALOG_SNAPSHOT_INVALID_INPUT',
      message: 'Catalog snapshot input is invalid',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('atomically applies an authoritative provider snapshot and scopes tombstones', async () => {
    transaction.modelCatalog.findMany.mockResolvedValue([
      persisted({ model: 'model-a' }),
      persisted({ id: 'row-2', model: 'removed' }),
    ]);
    const observedAt = new Date('2026-07-26T13:00:00.000Z');

    await repository.applyProviderSnapshot({
      connector: 'groq',
      rows: [row({ model: 'model-a' }), row({ model: 'added' })],
      source: 'provider-api',
      freshness: 'fresh',
      observedAt,
      authoritative: true,
    });

    // The snapshot transaction carries an explicit interactive-transaction
    // timeout above Prisma's 5000ms default — a large provider (orq: 524 models)
    // does ~524 sequential upserts and exceeded 5s, so the whole snapshot threw
    // a timeout surfaced as `reason=database` and its models were dropped.
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
      timeout: 120000,
      maxWait: 15000,
    });
    expect(transaction.modelCatalog.findMany).toHaveBeenCalledWith({
      where: { connector: 'groq' },
    });
    expect(transaction.catalogSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        connector: 'groq',
        source: 'provider-api',
        observedAt,
        authoritative: true,
        rowCount: 2,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(transaction.modelCatalog.updateMany).toHaveBeenCalledWith({
      where: {
        connector: 'groq',
        absent: false,
        model: { notIn: ['model-a', 'added'] },
      },
      data: {
        absent: true,
        absentSince: observedAt,
        snapshotId: 'snapshot-1',
      },
    });
    expect(transaction.catalogDriftEvent.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ model: 'added', changeType: 'added' }),
        expect.objectContaining({ model: 'removed', changeType: 'removed' }),
      ]),
    });
  });

  it('clears absent and absentSince when a model reappears', async () => {
    transaction.modelCatalog.findMany.mockResolvedValue([
      persisted({
        model: 'returned',
        absent: true,
        absentSince: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ]);

    await repository.applyProviderSnapshot({
      connector: 'groq',
      rows: [row({ model: 'returned' })],
      source: 'provider-api',
      freshness: 'fresh',
      observedAt: new Date('2026-07-26T13:00:00.000Z'),
      authoritative: true,
    });

    expect(transaction.modelCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ absent: false, absentSince: null }),
      }),
    );
    expect(transaction.catalogDriftEvent.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ model: 'returned', changeType: 'added' })],
    });
  });

  it('does not tombstone or emit drift for a non-authoritative fallback', async () => {
    await repository.applyProviderSnapshot({
      connector: 'groq',
      rows: [row()],
      source: 'static-capabilities',
      freshness: 'static',
      observedAt: new Date('2026-07-26T13:00:00.000Z'),
      authoritative: false,
    });

    expect(transaction.catalogSnapshot.create).toHaveBeenCalled();
    expect(transaction.modelCatalog.upsert).toHaveBeenCalled();
    expect(transaction.modelCatalog.updateMany).not.toHaveBeenCalled();
    expect(transaction.catalogDriftEvent.createMany).not.toHaveBeenCalled();
  });

  it('does not resurrect an authoritatively absent row from a non-authoritative floor', async () => {
    transaction.modelCatalog.findMany.mockResolvedValue([
      persisted({
        model: 'model-a',
        absent: true,
        absentSince: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ]);

    await repository.applyProviderSnapshot({
      connector: 'groq',
      rows: [row()],
      source: 'static-capabilities',
      freshness: 'static',
      observedAt: new Date('2026-07-26T13:00:00.000Z'),
      authoritative: false,
    });

    expect(transaction.modelCatalog.upsert).not.toHaveBeenCalled();
    expect(transaction.modelCatalog.updateMany).not.toHaveBeenCalled();
    expect(transaction.catalogDriftEvent.createMany).not.toHaveBeenCalled();
  });

  it('retries the entire serializable transaction after one P2034 conflict', async () => {
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2034', message: 'raw database detail' })
      .mockImplementationOnce(async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      );

    await repository.applyProviderSnapshot({
      connector: 'groq',
      rows: [row()],
      source: 'provider-api',
      freshness: 'fresh',
      observedAt: new Date('2026-07-26T13:00:00.000Z'),
      authoritative: true,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(transaction.modelCatalog.findMany).toHaveBeenCalledTimes(1);
  });

  it('fails sanitized after three P2034 conflicts', async () => {
    prisma.$transaction.mockRejectedValue({
      code: 'P2034',
      message: 'postgres host and query must not escape',
    });

    const promise = repository.applyProviderSnapshot({
      connector: 'groq',
      rows: [row()],
      source: 'provider-api',
      freshness: 'fresh',
      observedAt: new Date('2026-07-26T13:00:00.000Z'),
      authoritative: true,
    });

    await expect(promise).rejects.toEqual(
      expect.objectContaining({
        name: 'CatalogSnapshotConflictError',
        code: 'CATALOG_SNAPSHOT_CONFLICT',
        message: 'Catalog snapshot conflict; retry on the next refresh cycle',
      }),
    );
    await expect(promise).rejects.not.toHaveProperty('cause');
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(CatalogSnapshotConflictError).toBeDefined();
  });

  it('does not retry non-conflict database failures', async () => {
    const failure = new Error('write failed');
    prisma.$transaction.mockRejectedValue(failure);

    await expect(
      repository.applyProviderSnapshot({
        connector: 'groq',
        rows: [row()],
        source: 'provider-api',
        freshness: 'fresh',
        observedAt: new Date('2026-07-26T13:00:00.000Z'),
        authoritative: true,
      }),
    ).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('marks only live provider rows stale without advancing observedAt', async () => {
    prisma.modelCatalog.updateMany.mockResolvedValue({ count: 4 });
    const checkedAt = new Date('2026-07-26T13:00:00.000Z');

    await expect(repository.markProviderStale('groq', checkedAt)).resolves.toBe(4);
    expect(prisma.modelCatalog.updateMany).toHaveBeenCalledWith({
      where: { connector: 'groq', absent: false },
      data: { freshness: 'stale', lastChecked: checkedAt },
    });
  });

  it('retains status-only refresh and live read behavior', async () => {
    const checkedAt = new Date('2026-07-26T13:00:00.000Z');
    await repository.updateProviderStatus('groq', 'offline', checkedAt);
    await repository.findAll();

    expect(prisma.modelCatalog.updateMany).toHaveBeenCalledWith({
      where: { connector: 'groq' },
      data: { status: 'offline', lastChecked: checkedAt },
    });
    expect(prisma.modelCatalog.findMany).toHaveBeenCalledWith({
      where: { absent: false },
    });
  });
});

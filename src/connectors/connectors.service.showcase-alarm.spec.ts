// CONN-1674 — runtime alarm when a read-only SHOWCASE key's policy trims the
// public catalog past the threshold. This is the defense-in-depth layer that
// catches narrowing applied OUT of band (a direct DB edit, as CONN-1669 did
// 998→33) — the admin write-time guard cannot see those. Observational only:
// the alarm never alters the served response.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Queue } from 'bullmq';
import { ConnectorsService } from './connectors.service';
import { PrismaService } from '../prisma/prisma.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import { entryToRow } from './catalog-mapper';
import type { CatalogModelEntry } from './dto/catalog.dto';
import type { CatalogRepositoryLike, ModelCatalogRow } from './catalog.repository';
import type { ApiKeyPolicy } from '../policy/policy.schema';

const mockCfg = {
  PROVIDER_ACCESS: '',
  CATALOG_CACHE_ENABLED: false,
  CATALOG_CACHE_TTL_MS: 0,
  SHOWCASE_KEY_IDS: 'show-key',
  SHOWCASE_CATALOG_NARROW_ALARM_PCT: 0.5,
} as Record<string, unknown>;

vi.mock('../config/env.schema', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/env.schema')>()),
  getConfig: () => mockCfg,
}));

function entry(connector: string, model: string, free: boolean): CatalogModelEntry {
  return {
    connector,
    model,
    modality: 'chat',
    tags: free ? ['modality:chat', 'cost:free'] : ['modality:chat'],
    free,
    cheap: free,
    priceMultiplier: null,
    rateLimits: null,
    pricing: free ? null : { inputPerMTok: 5, outputPerMTok: 5, unit: 'per_1m_tokens' },
    contextWindow: 8192,
    maxOutputTokens: 4096,
    capabilities: { supportsStreaming: false, supportsJsonSchema: true, supportsTools: false },
    routing: { connector, model },
    routable: true,
    available: true,
  };
}

function repoFromEntries(entries: CatalogModelEntry[]): CatalogRepositoryLike {
  const rows: ModelCatalogRow[] = entries.map((e, i) => ({
    ...entryToRow(e),
    id: `row-${i}`,
    firstSeen: new Date('2026-07-01T00:00:00.000Z'),
    lastSeen: new Date('2026-07-05T16:00:00.000Z'),
    absent: false,
    snapshotId: `snap-${i}`,
    contentFingerprint: `${i}`.padStart(64, 'a').slice(-64),
    observedAt: new Date('2026-07-05T16:00:00.000Z'),
    source: 'provider-api',
    freshness: 'fresh',
    absentSince: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-05T16:00:00.000Z'),
  }));
  return { findAll: vi.fn().mockResolvedValue(rows) };
}

const emptyModalityCatalog = {
  getEntries: () => [],
  getFilteredEntries: () => [],
} as unknown as import('./modality-catalog.service').ModalityCatalogService;

// A large, mostly-paid catalog: free-only trims 8/10 = 80% (> 50% threshold).
const mixedEntries: CatalogModelEntry[] = [
  entry('openrouter', 'free-a', true),
  entry('openrouter', 'free-b', true),
  ...Array.from({ length: 8 }, (_, i) => entry('openrouter', `paid-${i}`, false)),
];

function buildService(policy: ApiKeyPolicy | null) {
  // ARAS-0058 — the request row and its settlement now commit together.
  const prisma: Record<string, unknown> = { request: { create: vi.fn().mockResolvedValue({}) } };
  prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
  const policyService = {
    getPolicyForKey: vi.fn(async () => policy),
    isProviderAllowed: () => true,
  };
  const service = new ConnectorsService(
    { add: vi.fn() } as unknown as Queue,
    prisma as unknown as PrismaService,
    { record: vi.fn(), getAll: vi.fn().mockReturnValue({}) } as never,
    new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
    emptyModalityCatalog,
    repoFromEntries(mixedEntries),
    null,
    undefined,
    policyService as never,
  );
  const warn = vi.spyOn(
    (service as unknown as { logger: { warn: (m: string) => void } }).logger,
    'warn',
  );
  return { service, warn };
}

const noFilters = { free: false, cheap: false, capability: undefined };

describe('CONN-1674 showcase catalog narrowing alarm', () => {
  beforeEach(() => {
    process.env.PROVIDER_ACCESS = '';
    mockCfg.SHOWCASE_KEY_IDS = 'show-key';
    mockCfg.SHOWCASE_CATALOG_NARROW_ALARM_PCT = 0.5;
  });

  it('WARNS when a showcase key policy trims past the threshold (free-only on the public key)', async () => {
    const { service, warn } = buildService({ policyVersion: 1, models: { mode: 'free-only' } });
    const res = await service.getCatalog(noFilters, 'show-key');
    expect(res.count).toBe(2); // response is STILL served (observational alarm)
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('CONN-1674');
    expect(warn.mock.calls[0][0]).toContain('show-key');
  });

  it('does NOT warn for a NON-showcase key with the same narrowing policy', async () => {
    const { service, warn } = buildService({ policyVersion: 1, models: { mode: 'free-only' } });
    await service.getCatalog(noFilters, 'email-agent-key');
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn for a showcase key whose policy does not narrow (unrestricted)', async () => {
    const { service, warn } = buildService(null);
    const res = await service.getCatalog(noFilters, 'show-key');
    expect(res.count).toBe(10);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn when the trim stays under the threshold', async () => {
    // Threshold 0.95 → 80% trim is under it, no alarm.
    mockCfg.SHOWCASE_CATALOG_NARROW_ALARM_PCT = 0.95;
    const { service, warn } = buildService({ policyVersion: 1, models: { mode: 'free-only' } });
    await service.getCatalog(noFilters, 'show-key');
    expect(warn).not.toHaveBeenCalled();
  });
});

// CONN-1665 — read surfaces filtered by the caller's per-key access policy:
// GET /v1/models (capabilities-derived) and GET /connectors/catalog
// (DB-catalog-derived). Discovery mirrors enforcement — a client never sees a
// model its key cannot call; under free-only, unknown-tier models are OMITTED.

import { describe, it, expect } from 'vitest';
import { ConnectorsService } from '../connectors/connectors.service';
import { PolicyService } from '../policy/policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { OpenAiCompatController } from './openai-compat.controller';
import { FailoverRouterService } from '../connectors/failover/failover-router.service';
import type { ApiKeyPolicy } from '../policy/policy.schema';
import type { ModelCatalogRow } from '../connectors/catalog.repository';
import {
  IConnector,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorCapabilities,
  ConnectorStatus,
} from '../connectors/interfaces/connector.interface';

class FakeConnector implements IConnector {
  constructor(
    public readonly name: string,
    private readonly modelIds: string[],
  ) {}
  readonly type = 'api' as const;
  async execute(_request: ConnectorRequest): Promise<ConnectorResponse> {
    throw new Error('not used in read-surface tests');
  }
  async getStatus(): Promise<ConnectorStatus> {
    return { name: this.name, healthy: true, activeJobs: 0, queuedJobs: 0, rateLimitStatus: 'ok' };
  }
  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: this.modelIds,
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 120_000,
      modelMeta: this.modelIds.map((id) => ({ id, modality: 'chat' as const })),
    };
  }
  resetCircuitBreaker() {
    return [];
  }
}

function catalogRow(
  connector: string,
  model: string,
  tier: 'free' | 'paid' | 'unknown',
): ModelCatalogRow {
  return {
    id: `${connector}-${model}`,
    connector,
    model,
    modality: 'chat',
    status: 'online',
    lastChecked: new Date('2026-08-12T00:00:00Z'),
    supportsStreaming: false,
    supportsJsonSchema: false,
    supportsTools: false,
    inputPerMTok: null,
    outputPerMTok: null,
    priceUnit: 'USD/1M tokens',
    tier,
    free: tier === 'free',
    priceMultiplier: null,
    contextWindow: null,
    maxOutputTokens: null,
    endpoint: null,
    executableHere: true,
    routable: true,
    firstSeen: new Date('2026-08-01T00:00:00Z'),
    lastSeen: new Date('2026-08-12T00:00:00Z'),
    absent: false,
    snapshotId: null,
    contentFingerprint: null,
    observedAt: new Date('2026-08-12T00:00:00Z'),
    source: 'provider-api',
    freshness: 'fresh',
  };
}

const API_KEY_ID = 'read-surface-key';

interface StackOptions {
  policy?: ApiKeyPolicy | null;
  tiers?: Record<string, Record<string, 'free' | 'paid' | 'unknown'>>;
  catalogRows?: ModelCatalogRow[];
}

function buildStack(connectors: FakeConnector[], opts: StackOptions = {}) {
  const prisma = {
    request: { create: () => Promise.resolve({}) },
    apiKey: { findUnique: async () => ({ policy: opts.policy ?? null }) },
    modelCatalog: {
      findUnique: async ({
        where,
      }: {
        where: { connector_model: { connector: string; model: string } };
      }) => {
        const tier = opts.tiers?.[where.connector_model.connector]?.[where.connector_model.model];
        return tier ? { tier, absent: false } : null;
      },
    },
  };
  const policyService = new PolicyService(prisma as unknown as PrismaService);
  const service = new ConnectorsService(
    {} as never,
    prisma as never,
    { record: () => undefined } as never,
    { wrapExecute: () => Promise.resolve({ response: null }) } as never,
    undefined,
    { findAll: async () => opts.catalogRows ?? [] },
    null,
    undefined,
    policyService,
  );
  for (const c of connectors) service.register(c);
  const controller = new OpenAiCompatController(new FailoverRouterService(service), service);
  return { service, controller };
}

describe('GET /v1/models per-key policy filter (CONN-1665)', () => {
  const req = { apiKey: { id: API_KEY_ID } } as never;
  const connectors = () => [
    new FakeConnector('openrouter', ['or-free', 'or-paid', 'or-mystery']),
    new FakeConnector('groq', ['groq-model']),
  ];

  it('legacy key (no policy) → full list', async () => {
    const { controller } = buildStack(connectors(), { policy: null });
    const out = await controller.listModels(req);
    expect(out.data.map((m) => m.id).sort()).toEqual([
      'groq-model',
      'or-free',
      'or-mystery',
      'or-paid',
    ]);
  });

  it('providers restriction hides other providers entirely', async () => {
    const { controller } = buildStack(connectors(), {
      policy: { policyVersion: 1, providers: ['groq'] },
    });
    const out = await controller.listModels(req);
    expect(out.data.map((m) => m.id)).toEqual(['groq-model']);
  });

  it('free-only: keeps catalog-free models, drops paid AND unknown-tier (fail-closed)', async () => {
    const { controller } = buildStack(connectors(), {
      policy: { policyVersion: 1, providers: ['openrouter'], models: { mode: 'free-only' } },
      tiers: { openrouter: { 'or-free': 'free', 'or-paid': 'paid' } }, // or-mystery: no row
    });
    const out = await controller.listModels(req);
    expect(out.data.map((m) => m.id)).toEqual(['or-free']);
  });

  it('list mode keeps only listed model ids', async () => {
    const { controller } = buildStack(connectors(), {
      policy: { policyVersion: 1, models: { mode: 'list', list: ['groq-model'] } },
    });
    const out = await controller.listModels(req);
    expect(out.data.map((m) => m.id)).toEqual(['groq-model']);
  });
});

describe('GET /connectors/catalog per-key policy filter (CONN-1665)', () => {
  const rows = () => [
    catalogRow('openrouter', 'or-free', 'free'),
    catalogRow('openrouter', 'or-paid', 'paid'),
    catalogRow('openrouter', 'or-mystery', 'unknown'),
    catalogRow('groq', 'groq-model', 'free'),
  ];

  it('no apiKeyId / legacy key → unfiltered', async () => {
    const stack = buildStack([], { catalogRows: rows(), policy: null });
    const unauth = await stack.service.getCatalog({});
    expect(unauth.count).toBe(4);
    const legacy = await stack.service.getCatalog({}, API_KEY_ID);
    expect(legacy.count).toBe(4);
  });

  it('providers restriction filters the catalog', async () => {
    const { service } = buildStack([], {
      catalogRows: rows(),
      policy: { policyVersion: 1, providers: ['groq'] },
    });
    const out = await service.getCatalog({}, API_KEY_ID);
    expect(out.models.map((m) => `${m.connector}:${m.model}`)).toEqual(['groq:groq-model']);
    expect(out.count).toBe(1);
  });

  it('free-only omits paid and unknown-tier rows (fail-closed)', async () => {
    const { service } = buildStack([], {
      catalogRows: rows(),
      policy: { policyVersion: 1, models: { mode: 'free-only' } },
    });
    const out = await service.getCatalog({}, API_KEY_ID);
    expect(out.models.map((m) => m.model).sort()).toEqual(['groq-model', 'or-free']);
  });

  it('list mode keeps only listed model ids', async () => {
    const { service } = buildStack([], {
      catalogRows: rows(),
      policy: { policyVersion: 1, models: { mode: 'list', list: ['or-paid'] } },
    });
    const out = await service.getCatalog({}, API_KEY_ID);
    expect(out.models.map((m) => m.model)).toEqual(['or-paid']);
  });
});

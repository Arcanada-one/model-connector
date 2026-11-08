/**
 * Protected Lab profile guards on ConnectorsService.execute (unit, mocked connector).
 *
 * Named mutation evidence for new code: see REPORT.md.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';

import { ConnectorsService } from './connectors.service';
import type { BillingService } from '../billing/billing.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { MetricsService } from '../metrics/metrics.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import { ModalityCatalogService } from './modality-catalog.service';
import type {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  IConnector,
} from './interfaces/connector.interface';
import type { RequestIntentHandle } from '../billing/billing.service';
import { validateEnv } from '../config/env.schema';
import { BadRequestException } from '@nestjs/common';
import { BaseApiConnector, type ParsedApiOutput } from './base-api.connector';
import {
  NATIVE_PRICING_UNAVAILABLE,
  deriveProtectedPricePolicyRevision,
} from '../billing/protected-price-policy';
import {
  PROTECTED_DISPATCH_FENCE_DECISIONS,
  __testOnlyAdmitNonBaseProtectedFence,
  __testOnlyClearNonBaseProtectedFence,
} from './protected-dispatch-fence-admission';
import { CerebrasConnector } from './cerebras/cerebras.connector';
import { PerplexityConnector } from './perplexity/perplexity.connector';
import { AzureOpenAiConnector } from './azure-openai/azure-openai.connector';

function freshPricing(row: Record<string, unknown>) {
  return {
    ...row,
    // Relative freshness so wall-clock CI does not age out a fixed fixture.
    observedAt: new Date(Date.now() - 5 * 60 * 1000),
    freshness: 'fresh',
    authoritative: true,
  };
}

const BASE_ENV = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PREFIX: 'conn:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_MAX_CONCURRENCY: '4',
  STT_GROQ_API_KEY: 'test-groq-key',
  ADMIN_TOKEN: 'a'.repeat(32),
  WATCHER_REPAIR_TOKEN: 'b'.repeat(32),
  PROVIDER_ACCESS: 'mock,unfenced,liar',
};

function buildService(
  billing: Partial<BillingService>,
  connector: IConnector,
  catalogRepo: {
    findAll: () => Promise<unknown[]>;
    findPricing?: (connector: string, model: string) => Promise<unknown>;
  } = { findAll: async () => [] },
): ConnectorsService {
  const service = new ConnectorsService(
    { add: vi.fn() } as unknown as Queue,
    {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          request: {
            create: async () => ({ id: 'req-1' }),
          },
        }),
    } as unknown as PrismaService,
    { observe: vi.fn(), record: vi.fn() } as unknown as MetricsService,
    new OutputGuardMiddleware({ enabled: false, maxRetries: 0, timeoutMs: 1_000 }),
    new ModalityCatalogService(),
    catalogRepo as never,
    null,
    undefined,
    undefined,
    billing as BillingService,
  );
  service.register(connector);
  return service;
}

/**
 * Adverse subclass: inherits BaseApiConnector, overrides execute, and performs a
 * physical provider-call without `__beforeProviderFetch`. Must be refused at
 * admission with zero physical sends.
 */
class UnhookedProtectedSubclass extends BaseApiConnector {
  readonly name = 'unhooked';
  /** Inherited capability lies — admission must not trust this alone. */
  override readonly supportsProtectedDispatchFence = true as const;
  physicalSendCount = 0;

  protected getBaseUrl(): string {
    return 'https://unhooked.example';
  }
  protected buildRequestUrl(): string {
    return `${this.getBaseUrl()}/v1`;
  }
  protected buildRequestBody(): unknown {
    return {};
  }
  protected parseResponse(): ParsedApiOutput {
    return {
      text: '',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }
  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'unhooked',
      type: 'api',
      models: ['m'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 30_000,
    };
  }

  override async execute(_request: ConnectorRequest): Promise<ConnectorResponse> {
    this.physicalSendCount += 1;
    return {
      id: 'unhooked-1',
      connector: 'unhooked',
      model: 'm',
      result: 'sent',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
      latencyMs: 1,
      status: 'success',
    };
  }
}

/** Declares the fence; used for P1/P11 gates that run after admission. */
const fencedMockConnector: IConnector = {
  name: 'mock',
  supportsProtectedDispatchFence: true,
  type: 'api',
  execute: vi.fn(async () => {
    throw new Error('provider must not be called');
  }),
  getCapabilities: () => ({
    name: 'mock',
    type: 'api',
    models: ['m'],
    supportsStreaming: false,
    supportsJsonSchema: false,
    supportsTools: false,
    maxTimeout: 30_000,
  }),
  getStatus: async () => ({
    name: 'mock',
    healthy: true,
    activeJobs: 0,
    queuedJobs: 0,
    rateLimitStatus: 'ok',
  }),
  resetCircuitBreaker: () => [],
};

/** Declares no fence — must be refused at prepare/execute admission. */
const unfencedConnector: IConnector = {
  name: 'unfenced',
  type: 'api',
  // supportsProtectedDispatchFence intentionally absent
  execute: vi.fn(async () => {
    throw new Error('unfenced provider must not be called');
  }),
  getCapabilities: () => ({
    name: 'unfenced',
    type: 'api',
    models: ['m'],
    supportsStreaming: false,
    supportsJsonSchema: false,
    supportsTools: false,
    maxTimeout: 30_000,
  }),
  getStatus: async () => ({
    name: 'unfenced',
    healthy: true,
    activeJobs: 0,
    queuedJobs: 0,
    rateLimitStatus: 'ok',
  }),
  resetCircuitBreaker: () => [],
};

/**
 * Lies about the fence: declares the capability but never calls
 * `__beforeProviderFetch`. Exercises the reserved→unknown backstop.
 */
function lyingFencedConnector(): IConnector {
  return {
    name: 'liar',
    supportsProtectedDispatchFence: true,
    type: 'api',
    execute: vi.fn(async (_request: ConnectorRequest) => {
      // Deliberately skip __beforeProviderFetch.
      return {
        id: 'liar-1',
        connector: 'liar',
        model: 'm',
        result: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
        latencyMs: 1,
        status: 'success' as const,
      };
    }),
    getCapabilities: () => ({
      name: 'liar',
      type: 'api',
      models: ['m'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 30_000,
    }),
    getStatus: async () => ({
      name: 'liar',
      healthy: true,
      activeJobs: 0,
      queuedJobs: 0,
      rateLimitStatus: 'ok' as const,
    }),
    resetCircuitBreaker: () => [],
  };
}

describe('protected Lab profile execute guards', () => {
  beforeEach(() => {
    // Bare name = read+use. `mock:read,use` would parse as mock:read AND a
    // separate provider literally named "use".
    process.env.PROVIDER_ACCESS = 'mock,unfenced,liar';
    vi.clearAllMocks();
    __testOnlyClearNonBaseProtectedFence();
    // Production non-Base admissions are empty. Vitest-only seam admits the
    // profile doubles that intentionally exercise post-admission paths.
    __testOnlyAdmitNonBaseProtectedFence('mock', { forwardsMaxTokens: true });
    __testOnlyAdmitNonBaseProtectedFence('liar', { forwardsMaxTokens: true });
  });

  it('P1: protected execute without reservation_ref refuses null-intent/dark fallback', async () => {
    const billing = {
      lookupProtectedReservation: vi.fn(),
      releaseIntent: vi.fn(),
    };
    const service = buildService(billing, fencedMockConnector);

    const response = await service.execute(
      'mock',
      {
        prompt: 'hi',
        model: 'm',
        protectedProfile: true,
      },
      'key-1',
    );

    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('protected_reservation_required');
    expect(billing.lookupProtectedReservation).not.toHaveBeenCalled();
  });

  it('P1 positive: billing absent on protected profile still refuses dark fallback', async () => {
    const service = new ConnectorsService(
      { add: vi.fn() } as unknown as Queue,
      {} as unknown as PrismaService,
      { observe: vi.fn() } as unknown as MetricsService,
      new OutputGuardMiddleware({ enabled: false, maxRetries: 0, timeoutMs: 1_000 }),
    );
    service.register(fencedMockConnector);

    const response = await service.execute(
      'mock',
      {
        prompt: 'hi',
        model: 'm',
        protectedProfile: true,
        reservationRef: '11111111-1111-4111-8111-111111111111',
      },
      'key-1',
    );

    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('protected_billing_required');
  });

  it('P11: protected profile refuses output-guard redispatch', async () => {
    const billing = {
      lookupProtectedReservation: vi.fn(),
      releaseIntent: vi.fn(),
    };
    const service = buildService(billing, fencedMockConnector);

    const response = await service.execute(
      'mock',
      {
        prompt: 'hi',
        model: 'm',
        protectedProfile: true,
        reservationRef: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'op-1',
        output_format: 'json',
      },
      'key-1',
    );

    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('protected_retry_refused');
    expect(billing.lookupProtectedReservation).not.toHaveBeenCalled();
  });

  it('empty allow-list admits no connector (fail-closed)', () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: '',
    });
    const service = buildService({}, fencedMockConnector);
    expect(service.protectedLabConnectors().size).toBe(0);
    expect(() => service.assertProtectedConnectorAdmitted('mock')).toThrow(BadRequestException);
  });

  it('allow-listed but unfenced connector is refused at execute', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'unfenced',
    });
    const billing = {
      lookupProtectedReservation: vi.fn(),
      releaseIntent: vi.fn(),
      markProtectedUnknown: vi.fn(),
    };
    const service = buildService(billing, unfencedConnector);

    const response = await service.execute(
      'unfenced',
      {
        prompt: 'hi',
        model: 'm',
        protectedProfile: true,
        reservationRef: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'op-unfenced',
      },
      'key-1',
    );

    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('protected_connector_unfenced');
    expect(billing.lookupProtectedReservation).not.toHaveBeenCalled();
    expect(unfencedConnector.execute).not.toHaveBeenCalled();
  });

  it('positive: allow-listed fenced connector passes admission', () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const service = buildService({}, fencedMockConnector);
    expect(() => service.assertProtectedConnectorAdmitted('mock')).not.toThrow();
    expect(service.connectorSupportsProtectedDispatchFence('mock')).toBe(true);
  });

  it('backstop: lying fenced connector that skips the hook marks reserved unknown', async () => {
    const intent = {
      id: 'intent-liar',
      apiKeyId: 'key-1',
      intentKey: 'op-liar',
      holdUsd: { toString: () => '1' },
      lifecycleVersion: 1,
      protectedPhase: 'reserved',
      generation: 1,
    } as unknown as RequestIntentHandle;

    const markProtectedUnknown = vi.fn(async (handle: RequestIntentHandle) => {
      handle.protectedPhase = 'unknown';
      return true;
    });
    const releaseIntent = vi.fn(async () => false);
    const settleIntentInTx = vi.fn(async () => true);

    const billing = {
      lookupProtectedReservation: vi.fn(async () => ({
        outcome: 'found' as const,
        reservation: {
          reservationRef: '11111111-1111-4111-8111-111111111111',
          intentId: intent.id,
          intentKey: 'op-liar',
          apiKeyId: 'key-1',
          operationKey: 'op-liar',
          payloadFingerprint: ConnectorsService['requestFingerprint']('liar', {
            prompt: 'hi',
            model: 'm',
            idempotencyKey: 'op-liar',
            reservationRef: '11111111-1111-4111-8111-111111111111',
            protectedProfile: true as const,
          }),
          providerName: 'liar',
          modelName: 'm',
          routeKey: 'connectors/liar/protected/execute',
          pricePolicyRevision: 'catalog:x',
          holdUsd: '1',
          amountUnit: 'USD',
          amountPrecision: 6,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generation: 1,
          protectedPhase: 'reserved' as const,
          lifecycleVersion: 1 as const,
        },
        intent,
      })),
      markProtectedUnknown,
      releaseIntent,
      settleIntentInTx,
      settleInTx: vi.fn(),
      releaseIntentInTx: vi.fn(),
    };

    const liar = lyingFencedConnector();
    const service = buildService(billing, liar);

    const response = await service.execute(
      'liar',
      {
        prompt: 'hi',
        model: 'm',
        protectedProfile: true,
        reservationRef: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'op-liar',
      },
      'key-1',
    );

    expect(liar.execute).toHaveBeenCalled();
    expect(markProtectedUnknown).toHaveBeenCalled();
    expect(intent.protectedPhase).toBe('unknown');
    expect(releaseIntent).not.toHaveBeenCalled();
    // Response may succeed or error depending on settle; the fence invariant is unknown + no release.
    expect(response.status === 'success' || response.status === 'error').toBe(true);
  });

  it('adverse: fenced-declared subclass that skips the hook is refused before any physical send', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'mock,unfenced,liar,unhooked',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'unhooked',
    });
    const intent = {
      id: 'intent-unhooked',
      apiKeyId: 'key-1',
      intentKey: 'op-unhooked',
      holdUsd: { toString: () => '1' },
      lifecycleVersion: 1,
      protectedPhase: 'reserved',
      generation: 1,
    } as unknown as RequestIntentHandle;
    const billing = {
      lookupProtectedReservation: vi.fn(async () => ({
        outcome: 'found' as const,
        reservation: {
          reservationRef: '11111111-1111-4111-8111-111111111111',
          intentId: intent.id,
          intentKey: 'op-unhooked',
          apiKeyId: 'key-1',
          operationKey: 'op-unhooked',
          payloadFingerprint: ConnectorsService['requestFingerprint']('unhooked', {
            prompt: 'hi',
            model: 'm',
            idempotencyKey: 'op-unhooked',
            reservationRef: '11111111-1111-4111-8111-111111111111',
            protectedProfile: true as const,
          }),
          providerName: 'unhooked',
          modelName: 'm',
          routeKey: 'connectors/unhooked/protected/execute',
          pricePolicyRevision: 'catalog:x',
          holdUsd: '1',
          amountUnit: 'USD',
          amountPrecision: 6,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          generation: 1,
          protectedPhase: 'reserved' as const,
          lifecycleVersion: 1 as const,
        },
        intent,
      })),
      commitProtectedDispatch: vi.fn(async () => true),
      markProtectedUnknown: vi.fn(async () => true),
      releaseIntent: vi.fn(async () => false),
      settleIntentInTx: vi.fn(async () => true),
      settleInTx: vi.fn(),
      releaseIntentInTx: vi.fn(),
      prepareProtectedReservation: vi.fn(),
    };
    const unhooked = new UnhookedProtectedSubclass();
    // Inherited/override boolean claims the fence — still not on the class allow-list.
    expect(unhooked.supportsProtectedDispatchFence).toBe(true);
    expect(
      PROTECTED_DISPATCH_FENCE_DECISIONS.some(
        (d) => d.className === 'UnhookedProtectedSubclass' && d.decision === 'admitted',
      ),
    ).toBe(false);

    const service = buildService(billing, unhooked);

    const response = await service.execute(
      'unhooked',
      {
        prompt: 'hi',
        model: 'm',
        protectedProfile: true,
        reservationRef: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'op-unhooked',
      },
      'key-1',
    );

    // Physical-send counter must stay zero: admission refuses before execute.
    // Under the inherited-boolean mutation this becomes 1 (RED proof).
    expect(unhooked.physicalSendCount).toBe(0);
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('protected_connector_unfenced');
    expect(service.connectorSupportsProtectedDispatchFence('unhooked')).toBe(false);
    expect(billing.lookupProtectedReservation).not.toHaveBeenCalled();
    expect(billing.prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('prepare: client zero: for a paid catalogue row is refused (never a zero hold)', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const prepareProtectedReservation = vi.fn();
    const billing = { prepareProtectedReservation };
    const paidFp = 'c'.repeat(64);
    const service = buildService(billing, fencedMockConnector, {
      findAll: async () => [],
      findPricing: async () =>
        freshPricing({
          connector: 'mock',
          model: 'paid-m',
          tier: 'paid',
          inputPerMTok: 10,
          outputPerMTok: 30,
          contentFingerprint: paidFp,
          snapshotId: 'snap',
        }),
    });

    const result = await service.prepareProtectedReservation(
      'mock',
      {
        prompt: 'hello world',
        model: 'paid-m',
        idempotencyKey: 'op-fake-zero',
        extra: { max_tokens: 2_000 },
      },
      'key-1',
      'zero:attacker',
    );

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.code).toBe('protected_price_revision_mismatch');
    }
    expect(prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('prepare: valid paid catalogue pin opens with a positive server hold', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const prepareProtectedReservation = vi.fn(async (params: Record<string, unknown>) => ({
      outcome: 'opened' as const,
      reservation: {
        reservationRef: '11111111-1111-4111-8111-111111111111',
        holdUsd: String(params.holdUsd),
        pricePolicyRevision: String(params.pricePolicyRevision),
      },
      intent: {},
    }));
    const paidFp = 'd'.repeat(64);
    const service = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      fencedMockConnector,
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'mock',
            model: 'paid-m',
            tier: 'paid',
            inputPerMTok: 10,
            outputPerMTok: 30,
            contentFingerprint: paidFp,
            snapshotId: 'snap',
          }),
      },
    );

    const result = await service.prepareProtectedReservation(
      'mock',
      {
        prompt: 'hello world',
        model: 'paid-m',
        idempotencyKey: 'op-paid',
        extra: { max_tokens: 2_000 },
      },
      'key-1',
    );

    expect(result.outcome).toBe('opened');
    expect(prepareProtectedReservation).toHaveBeenCalledTimes(1);
    const call = prepareProtectedReservation.mock.calls[0][0] as {
      holdUsd: string;
      pricePolicyRevision: string;
    };
    expect(call.pricePolicyRevision).toBe(
      deriveProtectedPricePolicyRevision(
        {
          connector: 'mock',
          model: 'paid-m',
          tier: 'paid',
          inputPerMTok: 10,
          outputPerMTok: 30,
          contentFingerprint: paidFp,
          snapshotId: 'snap',
        },
        'connectors/mock/protected/execute',
      ),
    );
    expect(call.pricePolicyRevision).not.toBe(`catalog:${paidFp}`);
    expect(Number(call.holdUsd)).toBeGreaterThan(0);
  });

  it('prepare: server-pinned zero-price catalogue row opens a zero hold', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const prepareProtectedReservation = vi.fn(async (params: Record<string, unknown>) => ({
      outcome: 'opened' as const,
      reservation: {
        reservationRef: '11111111-1111-4111-8111-111111111112',
        holdUsd: String(params.holdUsd),
        pricePolicyRevision: String(params.pricePolicyRevision),
      },
      intent: {},
    }));
    const freeFp = 'e'.repeat(64);
    const service = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      fencedMockConnector,
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'mock',
            model: 'free-m',
            tier: 'free',
            free: true,
            inputPerMTok: 0,
            outputPerMTok: 0,
            contentFingerprint: freeFp,
            snapshotId: 'snap-free',
          }),
      },
    );

    const result = await service.prepareProtectedReservation(
      'mock',
      {
        prompt: 'hello world',
        model: 'free-m',
        idempotencyKey: 'op-free',
        extra: { max_tokens: 2_000 },
      },
      'key-1',
    );

    expect(result.outcome).toBe('opened');
    const call = prepareProtectedReservation.mock.calls[0][0] as {
      holdUsd: string;
      pricePolicyRevision: string;
    };
    expect(call.pricePolicyRevision).toBe(
      deriveProtectedPricePolicyRevision(
        {
          connector: 'mock',
          model: 'free-m',
          tier: 'free',
          free: true,
          inputPerMTok: 0,
          outputPerMTok: 0,
          contentFingerprint: freeFp,
          snapshotId: 'snap-free',
        },
        'connectors/mock/protected/execute',
      ),
    );
    expect(call.pricePolicyRevision).not.toBe(`zero:catalog:${freeFp}`);
    expect(call.holdUsd).toBe('0.000000');
  });

  it('M-NONBASE: unlisted non-Base own-boolean true is refused before any physical send', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'rogue',
      PROVIDER_ACCESS: 'mock,unfenced,liar,rogue',
    });
    // Deliberately NOT admitted via the test-only seam.
    let physicalSendCount = 0;
    const rogue: IConnector = {
      name: 'rogue',
      supportsProtectedDispatchFence: true,
      type: 'api',
      execute: vi.fn(async () => {
        physicalSendCount += 1;
        throw new Error('rogue must not be called');
      }),
      getCapabilities: () => ({
        name: 'rogue',
        type: 'api',
        models: ['m'],
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
        maxTimeout: 30_000,
      }),
      getStatus: async () => ({
        name: 'rogue',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      }),
      resetCircuitBreaker: () => [],
    };

    const billing = {
      lookupProtectedReservation: vi.fn(),
      prepareProtectedReservation: vi.fn(),
    };
    const service = buildService(billing, rogue);

    expect(rogue.supportsProtectedDispatchFence).toBe(true);
    expect(service.connectorSupportsProtectedDispatchFence('rogue')).toBe(false);

    const response = await service.execute(
      'rogue',
      {
        prompt: 'hi',
        model: 'm',
        protectedProfile: true,
        reservationRef: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'op-rogue',
      },
      'key-1',
    );

    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('protected_connector_unfenced');
    expect(billing.lookupProtectedReservation).not.toHaveBeenCalled();
    expect(billing.prepareProtectedReservation).not.toHaveBeenCalled();
    expect(physicalSendCount).toBe(0);
    expect(rogue.execute).not.toHaveBeenCalled();
  });

  it('M-OWNPROP: inherited prototype supportsProtectedDispatchFence is refused', () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'proto-fence',
    });
    // Even with an explicit non-Base admission, the fence flag must be an OWN
    // property — an inherited prototype true must not admit.
    __testOnlyAdmitNonBaseProtectedFence('proto-fence', { forwardsMaxTokens: true });
    const fenceProto = { supportsProtectedDispatchFence: true as const };
    const protoFenceConnector = Object.assign(Object.create(fenceProto), {
      name: 'proto-fence',
      type: 'api' as const,
      execute: vi.fn(async () => {
        throw new Error('prototype-fence provider must not be called');
      }),
      getCapabilities: () => ({
        name: 'proto-fence',
        type: 'api' as const,
        models: ['m'],
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
        maxTimeout: 30_000,
      }),
      getStatus: async () => ({
        name: 'proto-fence',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok' as const,
      }),
      resetCircuitBreaker: () => [],
    }) as IConnector;

    expect(
      Object.prototype.hasOwnProperty.call(protoFenceConnector, 'supportsProtectedDispatchFence'),
    ).toBe(false);
    expect(protoFenceConnector.supportsProtectedDispatchFence).toBe(true);

    const service = buildService({}, protoFenceConnector);
    expect(service.connectorSupportsProtectedDispatchFence('proto-fence')).toBe(false);
    expect(() => service.assertProtectedConnectorAdmitted('proto-fence')).toThrow(
      BadRequestException,
    );
  });

  it('prepare: unreadable catalogue refuses with NATIVE_PRICING_UNAVAILABLE', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const prepareProtectedReservation = vi.fn();
    const service = buildService({ prepareProtectedReservation }, fencedMockConnector, {
      findAll: async () => {
        throw new Error('catalog down');
      },
      findPricing: async () => {
        throw new Error('catalog down');
      },
    });

    const result = await service.prepareProtectedReservation(
      'mock',
      { prompt: 'hello', model: 'm', idempotencyKey: 'op-down' },
      'key-1',
    );

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
    expect(prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('M-REPOAUTH: row without snapshot authoritative null refuses protected prepare', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const prepareProtectedReservation = vi.fn();
    const service = buildService({ prepareProtectedReservation }, fencedMockConnector, {
      findAll: async () => [],
      findPricing: async () => ({
        connector: 'mock',
        model: 'paid-m',
        tier: 'paid',
        inputPerMTok: 10,
        outputPerMTok: 30,
        contentFingerprint: 'f'.repeat(64),
        snapshotId: null,
        observedAt: new Date(Date.now() - 5 * 60 * 1000),
        freshness: 'fresh',
        authoritative: null,
      }),
    });

    const result = await service.prepareProtectedReservation(
      'mock',
      {
        prompt: 'hello',
        model: 'paid-m',
        idempotencyKey: 'op-repoauth',
        extra: { max_tokens: 2_000 },
      },
      'key-1',
    );

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
    expect(prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('M-SVCFWD: admitted Cerebras (forwardsMaxTokens false) refuses despite max_tokens', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'cerebras',
      PROVIDER_ACCESS: 'cerebras',
    });
    const prepareProtectedReservation = vi.fn();
    const service = buildService({ prepareProtectedReservation }, new CerebrasConnector(), {
      findAll: async () => [],
      findPricing: async () =>
        freshPricing({
          connector: 'cerebras',
          model: 'paid-m',
          tier: 'paid',
          inputPerMTok: 10,
          outputPerMTok: 30,
          contentFingerprint: 'c'.repeat(64),
          snapshotId: 'snap-cerebras',
        }),
    });

    const result = await service.prepareProtectedReservation(
      'cerebras',
      {
        prompt: 'hello',
        model: 'paid-m',
        idempotencyKey: 'op-svc-fwd',
        extra: { max_tokens: 2_000 },
      },
      'key-1',
    );

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
    }
    expect(prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('M-EXTRAS-SVC / M-PPLXSEARCH: protected Perplexity extras refuse on the service path', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'perplexity',
      PROVIDER_ACCESS: 'perplexity',
    });
    const prepareProtectedReservation = vi.fn(async (params: Record<string, unknown>) => ({
      outcome: 'opened' as const,
      reservation: {
        reservationRef: '11111111-1111-4111-8111-111111111199',
        holdUsd: String(params.holdUsd),
        pricePolicyRevision: String(params.pricePolicyRevision),
      },
      intent: {},
    }));
    const service = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      new PerplexityConnector(),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'perplexity',
            model: 'sonar',
            tier: 'paid',
            inputPerMTok: 10,
            outputPerMTok: 30,
            contentFingerprint: 'p'.repeat(64),
            snapshotId: 'snap-pplx',
          }),
      },
    );

    const missingKillSwitch = await service.prepareProtectedReservation(
      'perplexity',
      {
        prompt: 'hello',
        model: 'sonar',
        idempotencyKey: 'op-pplx-search-1',
        extra: { max_tokens: 128 },
      },
      'key-1',
    );
    expect(missingKillSwitch.outcome).toBe('refused');
    if (missingKillSwitch.outcome === 'refused') {
      expect(missingKillSwitch.code).toBe(NATIVE_PRICING_UNAVAILABLE);
      expect(missingKillSwitch.message).toMatch(/disable_search=true/);
    }

    const withSearchOptions = await service.prepareProtectedReservation(
      'perplexity',
      {
        prompt: 'hello',
        model: 'sonar',
        idempotencyKey: 'op-pplx-search-2',
        extra: {
          max_tokens: 128,
          disable_search: true,
          web_search_options: { search_context_size: 'high' },
        },
      },
      'key-1',
    );
    expect(withSearchOptions.outcome).toBe('refused');
    if (withSearchOptions.outcome === 'refused') {
      expect(withSearchOptions.code).toBe(NATIVE_PRICING_UNAVAILABLE);
      expect(withSearchOptions.message).toMatch(/web_search_options/);
    }
    // With countedInputBytes:0 on refuse, bypassing `if (!extras.ok)` would open a hold.
    expect(prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('M-PPLXRF: protected Perplexity response_format schema increases the hold', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'perplexity',
      PROVIDER_ACCESS: 'perplexity',
    });
    const prepareProtectedReservation = vi.fn(async (params: Record<string, unknown>) => ({
      outcome: 'opened' as const,
      reservation: {
        reservationRef: '11111111-1111-4111-8111-111111111113',
        holdUsd: String(params.holdUsd),
        pricePolicyRevision: String(params.pricePolicyRevision),
      },
      intent: {},
    }));
    const service = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      new PerplexityConnector(),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'perplexity',
            model: 'sonar',
            tier: 'paid',
            inputPerMTok: 1_000_000,
            outputPerMTok: 0,
            contentFingerprint: 'q'.repeat(64),
            snapshotId: 'snap-pplx-rf',
          }),
      },
    );

    const base = await service.prepareProtectedReservation(
      'perplexity',
      {
        prompt: 'hi',
        model: 'sonar',
        idempotencyKey: 'op-pplx-rf-base',
        extra: { max_tokens: 1, disable_search: true },
      },
      'key-1',
    );
    const withSchema = await service.prepareProtectedReservation(
      'perplexity',
      {
        prompt: 'hi',
        model: 'sonar',
        idempotencyKey: 'op-pplx-rf-schema',
        extra: {
          max_tokens: 1,
          disable_search: true,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'big',
              schema: { type: 'object', properties: { a: { type: 'string' } } },
              description: 'D'.repeat(2_000),
            },
          },
        },
      },
      'key-1',
    );

    expect(base.outcome).toBe('opened');
    expect(withSchema.outcome).toBe('opened');
    const baseHold = Number(
      (prepareProtectedReservation.mock.calls[0][0] as { holdUsd: string }).holdUsd,
    );
    const schemaHold = Number(
      (prepareProtectedReservation.mock.calls[1][0] as { holdUsd: string }).holdUsd,
    );
    expect(schemaHold).toBeGreaterThan(baseHold);
  });

  it('M-AZURE-DEPLOY-CALLER: protected Azure refuses caller extra.deployment', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
      PROVIDER_ACCESS: 'azure-openai',
    });
    const prepareProtectedReservation = vi.fn();
    const service = buildService(
      { prepareProtectedReservation },
      new AzureOpenAiConnector({ deployment: 'gpt-paid' }),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-paid',
            tier: 'paid',
            inputPerMTok: 10,
            outputPerMTok: 30,
            contentFingerprint: 'a'.repeat(64),
            snapshotId: 'snap-azure',
          }),
      },
    );

    const result = await service.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: 'hello',
        model: 'gpt-paid',
        idempotencyKey: 'op-azure-deploy-caller',
        extra: { max_tokens: 64, deployment: 'cheap-other' },
      },
      'key-1',
    );

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.code).toBe(NATIVE_PRICING_UNAVAILABLE);
      expect(result.message).toMatch(/extra\.deployment/);
    }
    expect(prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('M-AZURE-DEPLOY-BIND: protected Azure requires configured deployment == priced model; route binds it', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
      PROVIDER_ACCESS: 'azure-openai',
    });
    const prepareProtectedReservation = vi.fn(async (params: Record<string, unknown>) => ({
      outcome: 'opened' as const,
      reservation: {
        reservationRef: '11111111-1111-4111-8111-111111111198',
        holdUsd: String(params.holdUsd),
        pricePolicyRevision: String(params.pricePolicyRevision),
      },
      intent: {},
    }));

    const mismatched = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      new AzureOpenAiConnector({ deployment: 'other-deployment' }),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-paid',
            tier: 'paid',
            inputPerMTok: 10,
            outputPerMTok: 30,
            contentFingerprint: 'b'.repeat(64),
            snapshotId: 'snap-azure-mis',
          }),
      },
    );
    const refused = await mismatched.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: 'hello',
        model: 'gpt-paid',
        idempotencyKey: 'op-azure-deploy-mis',
        extra: { max_tokens: 64 },
      },
      'key-1',
    );
    expect(refused.outcome).toBe('refused');
    if (refused.outcome === 'refused') {
      expect(refused.code).toBe(NATIVE_PRICING_UNAVAILABLE);
      expect(refused.message).toMatch(/deployment to equal the catalogue-priced model/);
    }

    const bound = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      new AzureOpenAiConnector({ deployment: 'gpt-paid' }),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-paid',
            tier: 'paid',
            inputPerMTok: 10,
            outputPerMTok: 30,
            contentFingerprint: 'c'.repeat(64),
            snapshotId: 'snap-azure-ok',
          }),
      },
    );
    const opened = await bound.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: 'hello',
        model: 'gpt-paid',
        idempotencyKey: 'op-azure-deploy-ok',
        extra: { max_tokens: 64 },
      },
      'key-1',
    );
    expect(opened.outcome).toBe('opened');
    expect(prepareProtectedReservation).toHaveBeenCalledTimes(1);
    const call = prepareProtectedReservation.mock.calls[0][0] as {
      routeKey: string;
      pricePolicyRevision: string;
    };
    expect(call.routeKey).toContain('azure-deployment=gpt-paid');
    const expectedRevision = deriveProtectedPricePolicyRevision(
      {
        connector: 'azure-openai',
        model: 'gpt-paid',
        tier: 'paid',
        inputPerMTok: 10,
        outputPerMTok: 30,
        contentFingerprint: 'c'.repeat(64),
        snapshotId: 'snap-azure-ok',
        authoritative: true,
        freshness: 'fresh',
      },
      call.routeKey,
    );
    expect(call.pricePolicyRevision).toBe(expectedRevision);
  });

  it('M-JSONOBJ-RF: server-set response_format json_object increases the protected input bound', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
      PROVIDER_ACCESS: 'azure-openai',
    });
    const prepareProtectedReservation = vi.fn(async (params: Record<string, unknown>) => ({
      outcome: 'opened' as const,
      reservation: {
        reservationRef: '11111111-1111-4111-8111-111111111197',
        holdUsd: String(params.holdUsd),
        pricePolicyRevision: String(params.pricePolicyRevision),
      },
      intent: {},
    }));
    const service = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      new AzureOpenAiConnector({ deployment: 'gpt-paid' }),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-paid',
            tier: 'paid',
            inputPerMTok: 1_000_000,
            outputPerMTok: 0,
            contentFingerprint: 'd'.repeat(64),
            snapshotId: 'snap-azure-rf',
          }),
      },
    );

    const base = await service.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: 'hi',
        model: 'gpt-paid',
        idempotencyKey: 'op-azure-rf-base',
        extra: { max_tokens: 1 },
      },
      'key-1',
    );
    const withRf = await service.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: 'hi',
        model: 'gpt-paid',
        idempotencyKey: 'op-azure-rf-json',
        responseFormat: { type: 'json_object' },
        extra: { max_tokens: 1 },
      },
      'key-1',
    );
    expect(base.outcome).toBe('opened');
    expect(withRf.outcome).toBe('opened');
    const baseHold = Number(
      (prepareProtectedReservation.mock.calls[0][0] as { holdUsd: string }).holdUsd,
    );
    const rfHold = Number(
      (prepareProtectedReservation.mock.calls[1][0] as { holdUsd: string }).holdUsd,
    );
    expect(rfHold).toBeGreaterThan(baseHold);
  });
});

describe('M-EXEC: protected execute reservation mismatch', () => {
  const REF = '11111111-1111-4111-8111-111111111155';

  beforeEach(() => {
    process.env.PROVIDER_ACCESS = 'mock,azure-openai,perplexity';
    vi.clearAllMocks();
    __testOnlyClearNonBaseProtectedFence();
    __testOnlyAdmitNonBaseProtectedFence('mock', { forwardsMaxTokens: true });
  });

  type CountingConnector = IConnector & { sendCount: () => number };

  function countingMock(name = 'mock'): CountingConnector {
    let sends = 0;
    return {
      name,
      supportsProtectedDispatchFence: true,
      type: 'api',
      execute: vi.fn(async (request: ConnectorRequest) => {
        const before = (
          request as ConnectorRequest & { __beforeProviderFetch?: () => Promise<void> }
        ).__beforeProviderFetch;
        if (typeof before === 'function') {
          await before();
        }
        sends += 1;
        return {
          id: `${name}-1`,
          connector: name,
          model: 'm',
          result: 'ok',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
          latencyMs: 1,
          status: 'success' as const,
        };
      }),
      getCapabilities: () => ({
        name,
        type: 'api' as const,
        models: ['m', 'm-other'],
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
        maxTimeout: 30_000,
      }),
      getStatus: async () => ({
        name,
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok' as const,
      }),
      resetCircuitBreaker: () => [],
      sendCount: () => sends,
    };
  }

  function baseRequest(overrides: Record<string, unknown> = {}) {
    return {
      prompt: 'hello',
      model: 'm',
      protectedProfile: true as const,
      reservationRef: REF,
      idempotencyKey: 'op-exec-match',
      extra: { max_tokens: 64 } as Record<string, unknown>,
      ...overrides,
    };
  }

  function openHold(connectorName: string, prepared: ReturnType<typeof baseRequest>) {
    const intent = {
      id: 'intent-exec',
      apiKeyId: 'key-1',
      intentKey: prepared.idempotencyKey,
      holdUsd: { toString: () => '1.25' },
      lifecycleVersion: 1,
      protectedPhase: 'reserved' as string,
      generation: 1,
    } as unknown as RequestIntentHandle;

    const reservation = {
      reservationRef: REF,
      intentId: intent.id,
      intentKey: String(prepared.idempotencyKey),
      apiKeyId: 'key-1',
      operationKey: String(prepared.idempotencyKey),
      payloadFingerprint: ConnectorsService['requestFingerprint'](connectorName, prepared as never),
      providerName: connectorName,
      modelName: String(prepared.model),
      routeKey: `connectors/${connectorName}/protected/execute`,
      pricePolicyRevision: 'catalog:x',
      holdUsd: '1.25',
      amountUnit: 'USD',
      amountPrecision: 6,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      generation: 1,
      protectedPhase: 'reserved' as const,
      lifecycleVersion: 1 as const,
    };

    const settleIntentInTx = vi.fn(async () => true);
    const releaseIntent = vi.fn(async () => false);
    const commitProtectedDispatch = vi.fn(async (handle: RequestIntentHandle) => {
      handle.protectedPhase = 'dispatch_committed';
      return true;
    });
    const markProtectedUnknown = vi.fn(async () => true);
    const billing = {
      lookupProtectedReservation: vi.fn(async () => ({
        outcome: 'found' as const,
        reservation,
        intent,
      })),
      commitProtectedDispatch,
      markProtectedUnknown,
      releaseIntent,
      settleIntentInTx,
      settleInTx: vi.fn(),
      releaseIntentInTx: vi.fn(),
    };
    return {
      intent,
      reservation,
      billing,
      settleIntentInTx,
      releaseIntent,
      commitProtectedDispatch,
      markProtectedUnknown,
    };
  }

  async function expectMismatch(params: {
    connector: IConnector;
    connectorName: string;
    prepared: ReturnType<typeof baseRequest>;
    executeRequest: ReturnType<typeof baseRequest>;
    sendCount?: () => number;
  }) {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'mock,azure-openai,perplexity',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: params.connectorName,
    });
    const {
      intent,
      billing,
      settleIntentInTx,
      releaseIntent,
      commitProtectedDispatch,
      markProtectedUnknown,
    } = openHold(params.connectorName, params.prepared);
    const service = buildService(billing, params.connector);
    const response = await service.execute(
      params.connectorName,
      params.executeRequest as never,
      'key-1',
    );
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('protected_reservation_mismatch');
    if (params.sendCount) {
      expect(params.sendCount()).toBe(0);
    } else if ('execute' in params.connector && typeof params.connector.execute === 'function') {
      expect(params.connector.execute).not.toHaveBeenCalled();
    }
    expect(intent.protectedPhase).toBe('reserved');
    expect(settleIntentInTx).not.toHaveBeenCalled();
    expect(releaseIntent).not.toHaveBeenCalled();
    expect(commitProtectedDispatch).not.toHaveBeenCalled();
    expect(markProtectedUnknown).not.toHaveBeenCalled();
  }

  it('M-EXEC-FP (a): Azure extra.deployment added only at execute → mismatch, zero sends', async () => {
    const prepared = baseRequest({
      model: 'gpt-paid',
      idempotencyKey: 'op-azure-exec',
      extra: { max_tokens: 64 },
    });
    const azure = new AzureOpenAiConnector({ deployment: 'gpt-paid' });
    const executeSpy = vi.spyOn(azure, 'execute');
    await expectMismatch({
      connector: azure,
      connectorName: 'azure-openai',
      prepared,
      executeRequest: {
        ...prepared,
        extra: { max_tokens: 64, deployment: 'other-deploy' },
      },
      sendCount: () => executeSpy.mock.calls.length,
    });
  });

  it('M-EXEC-FP (b): Perplexity search option added only at execute → mismatch, zero sends', async () => {
    const prepared = baseRequest({
      model: 'sonar',
      idempotencyKey: 'op-pplx-exec',
      extra: { max_tokens: 64, disable_search: true },
    });
    const pplx = new PerplexityConnector();
    const executeSpy = vi.spyOn(pplx, 'execute');
    await expectMismatch({
      connector: pplx,
      connectorName: 'perplexity',
      prepared,
      executeRequest: {
        ...prepared,
        extra: {
          max_tokens: 64,
          disable_search: true,
          web_search_options: { search_context_size: 'high' },
        },
      },
      sendCount: () => executeSpy.mock.calls.length,
    });
  });

  it('M-EXEC-FP (c): larger prompt at execute → mismatch, zero sends', async () => {
    const connector = countingMock();
    const prepared = baseRequest({ prompt: 'short' });
    await expectMismatch({
      connector,
      connectorName: 'mock',
      prepared,
      executeRequest: { ...prepared, prompt: 'short'.padEnd(400, 'X') },
      sendCount: () => connector.sendCount(),
    });
  });

  it('M-EXEC-FP (d): larger max_tokens at execute → mismatch, zero sends', async () => {
    const connector = countingMock();
    const prepared = baseRequest({ extra: { max_tokens: 64 } });
    await expectMismatch({
      connector,
      connectorName: 'mock',
      prepared,
      executeRequest: { ...prepared, extra: { max_tokens: 4096 } },
      sendCount: () => connector.sendCount(),
    });
  });

  it('M-EXEC-MODEL (e): different model at execute → mismatch, zero sends', async () => {
    // Isolate the modelName comparison from the fingerprint check: fingerprint
    // matches the execute payload, but reservation.modelName stays on the
    // prepared model (defense-in-depth field on the reservation row).
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'mock',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const connector = countingMock();
    const prepared = baseRequest({ model: 'm' });
    const executeRequest = { ...prepared, model: 'm-other' };
    const {
      intent,
      reservation,
      billing,
      settleIntentInTx,
      releaseIntent,
      commitProtectedDispatch,
      markProtectedUnknown,
    } = openHold('mock', executeRequest);
    reservation.modelName = String(prepared.model);
    const service = buildService(billing, connector);
    const response = await service.execute('mock', executeRequest as never, 'key-1');
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('protected_reservation_mismatch');
    expect(connector.sendCount()).toBe(0);
    expect(intent.protectedPhase).toBe('reserved');
    expect(settleIntentInTx).not.toHaveBeenCalled();
    expect(releaseIntent).not.toHaveBeenCalled();
    expect(commitProtectedDispatch).not.toHaveBeenCalled();
    expect(markProtectedUnknown).not.toHaveBeenCalled();
  });

  it('M-EXEC-KEY (f): different idempotencyKey at execute → mismatch, zero sends', async () => {
    const connector = countingMock();
    const prepared = baseRequest({ idempotencyKey: 'op-exec-match' });
    await expectMismatch({
      connector,
      connectorName: 'mock',
      prepared,
      executeRequest: { ...prepared, idempotencyKey: 'op-exec-other' },
      sendCount: () => connector.sendCount(),
    });
  });

  it('positive control: identical request executes (one physical send)', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'mock',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const connector = countingMock();
    const prepared = baseRequest();
    const { intent, billing, commitProtectedDispatch, settleIntentInTx } = openHold(
      'mock',
      prepared,
    );
    const service = buildService(billing, connector);
    const response = await service.execute('mock', prepared as never, 'key-1');
    expect(response.status).toBe('success');
    expect(connector.sendCount()).toBe(1);
    expect(commitProtectedDispatch).toHaveBeenCalled();
    expect(intent.protectedPhase).not.toBe('reserved');
    expect(settleIntentInTx).toHaveBeenCalled();
  });
});

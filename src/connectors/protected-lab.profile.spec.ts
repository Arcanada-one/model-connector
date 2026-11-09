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
import * as fenceAdmission from './protected-dispatch-fence-admission';
import { PROTECTED_DISPATCH_FENCE_DECISIONS } from './protected-dispatch-fence-admission';
import { CerebrasConnector } from './cerebras/cerebras.connector';
import { PerplexityConnector } from './perplexity/perplexity.connector';
import {
  AzureOpenAiConnector,
  buildAzureOpenAiChatCompletionsUrl,
  encodeAzureTargetIntoRouteKey,
  type AzureProtectedEffectiveTarget,
} from './azure-openai/azure-openai.connector';
import { protectedForwardedExtrasAuthority } from '../billing/protected-forwarded-extras';
import {
  azureOpenAiChatFramingTokenAllowance,
  PROTECTED_AZURE_FRAMING_MODEL_UNSUPPORTED,
  protectedInputTokenUpperBound,
} from '../billing/protected-cost-estimate';
import { PROTECTED_RESERVATION_STALE } from '../billing/protected-lifecycle';

const AZURE_TEST_ENDPOINT = 'https://example.openai.azure.com';
const AZURE_TEST_API_VERSION = '2024-10-21';

/** Spec-local non-Base admissions — production module exports no mutator. */
const testNonBaseAdmissions = new Map<string, { forwardsMaxTokens: boolean }>();

function clearTestNonBaseProtectedFence(): void {
  testNonBaseAdmissions.clear();
}

function admitTestNonBaseProtectedFence(
  connectorName: string,
  opts: { forwardsMaxTokens?: boolean } = {},
): void {
  testNonBaseAdmissions.set(connectorName, {
    forwardsMaxTokens: opts.forwardsMaxTokens === true,
  });
}

function installNonBaseFenceSpies(): void {
  vi.spyOn(fenceAdmission, 'isNonBaseProtectedFenceAdmitted').mockImplementation(
    (name) =>
      fenceAdmission.PROTECTED_NON_BASE_FENCE_ADMISSIONS.has(name) ||
      testNonBaseAdmissions.has(name),
  );
  vi.spyOn(fenceAdmission, 'nonBaseForwardsProtectedMaxTokens').mockImplementation(
    (name) => testNonBaseAdmissions.get(name)?.forwardsMaxTokens === true,
  );
}

function azureTestTarget(
  overrides: Partial<AzureProtectedEffectiveTarget> = {},
): AzureProtectedEffectiveTarget {
  return {
    kind: 'azure-openai',
    origin: AZURE_TEST_ENDPOINT,
    deployment: 'gpt-4o',
    apiVersion: AZURE_TEST_API_VERSION,
    ...overrides,
  };
}

function azureTestOptions(
  overrides: { endpoint?: string; deployment?: string; apiVersion?: string; apiKey?: string } = {},
) {
  return {
    endpoint: AZURE_TEST_ENDPOINT,
    deployment: 'gpt-4o',
    apiVersion: AZURE_TEST_API_VERSION,
    apiKey: 'test-key',
    ...overrides,
  };
}

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
    clearTestNonBaseProtectedFence();
    installNonBaseFenceSpies();
    // Production non-Base admissions are empty. Specs admit profile doubles via
    // vi.spyOn of the production lookup (no exported mutator, no VITEST env).
    admitTestNonBaseProtectedFence('mock', { forwardsMaxTokens: true });
    admitTestNonBaseProtectedFence('liar', { forwardsMaxTokens: true });
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
    admitTestNonBaseProtectedFence('proto-fence', { forwardsMaxTokens: true });
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

  it('M-SVCFWD: admitted non-forwarding mock (forwardsMaxTokens false) refuses despite max_tokens', async () => {
    // Cerebras is fence-refused for chat-framing (round 10). Keep the
    // forwardsMaxTokens:false service kill on a vitest-only admitted double.
    clearTestNonBaseProtectedFence();
    admitTestNonBaseProtectedFence('mock', { forwardsMaxTokens: false });
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
      PROVIDER_ACCESS: 'mock',
    });
    const prepareProtectedReservation = vi.fn();
    const service = buildService({ prepareProtectedReservation }, fencedMockConnector, {
      findAll: async () => [],
      findPricing: async () =>
        freshPricing({
          connector: 'mock',
          model: 'paid-m',
          tier: 'paid',
          inputPerMTok: 10,
          outputPerMTok: 30,
          contentFingerprint: 'c'.repeat(64),
          snapshotId: 'snap-svc-fwd',
        }),
    });

    const result = await service.prepareProtectedReservation(
      'mock',
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

  it('M-FRAMING framing-refuse: allow-listed Cerebras is refused at admission (no hold)', async () => {
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
          snapshotId: 'snap-cerebras-framing',
        }),
    });

    await expect(
      service.prepareProtectedReservation(
        'cerebras',
        {
          prompt: 'hello',
          model: 'paid-m',
          idempotencyKey: 'op-cerebras-framing',
          extra: { max_tokens: 2_000 },
        },
        'key-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('M-PPLX-EXCLUDE: allow-listed Perplexity is refused at admission/prepare/execute (zero sends, no hold)', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'perplexity',
      PROVIDER_ACCESS: 'perplexity',
    });
    const prepareProtectedReservation = vi.fn(async () => {
      throw new Error('hold must not open for excluded Perplexity');
    });
    const pplx = new PerplexityConnector();
    const executeSpy = vi.spyOn(pplx, 'execute');
    const service = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      pplx,
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

    expect(service.connectorSupportsProtectedDispatchFence('perplexity')).toBe(false);
    expect(() => service.assertProtectedConnectorAdmitted('perplexity')).toThrow(
      BadRequestException,
    );
    try {
      service.assertProtectedConnectorAdmitted('perplexity');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        error: 'protected_connector_unfenced',
      });
    }

    await expect(
      service.prepareProtectedReservation(
        'perplexity',
        {
          prompt: 'hello',
          model: 'sonar',
          idempotencyKey: 'op-pplx-exclude-1',
          extra: { max_tokens: 128, disable_search: true },
        },
        'key-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prepareProtectedReservation).not.toHaveBeenCalled();

    const execResponse = await service.execute(
      'perplexity',
      {
        prompt: 'hello',
        model: 'sonar',
        protectedProfile: true,
        idempotencyKey: 'op-pplx-exclude-exec',
        reservationRef: '11111111-1111-4111-8111-111111111199',
        extra: { max_tokens: 128, disable_search: true },
      } as never,
      'key-1',
    );
    expect(execResponse.status).toBe('error');
    expect(execResponse.error?.type).toBe('protected_connector_unfenced');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('M-PPLX-EXCLUDE positive: text-only protected prepare still works on an admitted class', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
      PROVIDER_ACCESS: 'mock',
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
      fencedMockConnector,
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'mock',
            model: 'm',
            tier: 'paid',
            inputPerMTok: 10,
            outputPerMTok: 20,
            contentFingerprint: 't'.repeat(64),
            snapshotId: 'snap-text',
          }),
      },
    );
    const prepared = await service.prepareProtectedReservation(
      'mock',
      {
        prompt: 'text only',
        model: 'm',
        idempotencyKey: 'op-text-only',
        extra: { max_tokens: 32 },
      },
      'key-1',
    );
    expect(prepared.outcome).toBe('opened');
    expect(prepareProtectedReservation).toHaveBeenCalledTimes(1);
  });

  it('M-IMAGE: image_url ContentBlock refuses with NATIVE_PRICING_UNAVAILABLE and opens no hold', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
      PROVIDER_ACCESS: 'mock',
    });
    const prepareProtectedReservation = vi.fn(async (params: Record<string, unknown>) => ({
      outcome: 'opened' as const,
      reservation: {
        reservationRef: '11111111-1111-4111-8111-111111111114',
        holdUsd: String(params.holdUsd),
        pricePolicyRevision: String(params.pricePolicyRevision),
      },
      intent: {},
    }));
    const service = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      fencedMockConnector,
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'mock',
            model: 'm',
            tier: 'paid',
            inputPerMTok: 10,
            outputPerMTok: 20,
            contentFingerprint: 'i'.repeat(64),
            snapshotId: 'snap-img',
          }),
      },
    );
    const refused = await service.prepareProtectedReservation(
      'mock',
      {
        prompt: [
          { type: 'text', text: 'see' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAAA' },
          },
        ],
        model: 'm',
        idempotencyKey: 'op-img-refuse',
        extra: { max_tokens: 32 },
      },
      'key-1',
    );
    expect(refused.outcome).toBe('refused');
    if (refused.outcome === 'refused') {
      expect(refused.code).toBe(NATIVE_PRICING_UNAVAILABLE);
      expect(refused.message).toMatch(/image_url/);
    }
    expect(prepareProtectedReservation).not.toHaveBeenCalled();

    const textOnly = await service.prepareProtectedReservation(
      'mock',
      {
        prompt: 'text only',
        model: 'm',
        idempotencyKey: 'op-img-text',
        extra: { max_tokens: 32 },
      },
      'key-1',
    );
    expect(textOnly.outcome).toBe('opened');
    expect(prepareProtectedReservation).toHaveBeenCalledTimes(1);
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
      new AzureOpenAiConnector(azureTestOptions()),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-4o',
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
        model: 'gpt-4o',
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
      new AzureOpenAiConnector(azureTestOptions({ deployment: 'other-deployment' })),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-4o',
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
        model: 'gpt-4o',
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
      new AzureOpenAiConnector(azureTestOptions()),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-4o',
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
        model: 'gpt-4o',
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
    expect(call.routeKey).toContain('azure-deployment=gpt-4o');
    expect(call.routeKey).toContain(`azure-origin=${encodeURIComponent(AZURE_TEST_ENDPOINT)}`);
    expect(call.routeKey).toContain(
      `azure-api-version=${encodeURIComponent(AZURE_TEST_API_VERSION)}`,
    );
    const expectedRevision = deriveProtectedPricePolicyRevision(
      {
        connector: 'azure-openai',
        model: 'gpt-4o',
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

  it('M-JSONOBJ-RF: server-set response_format json_object refuses on protected Azure', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
      PROVIDER_ACCESS: 'azure-openai',
    });
    const prepareProtectedReservation = vi.fn();
    const service = buildService(
      { prepareProtectedReservation },
      new AzureOpenAiConnector(azureTestOptions()),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-4o',
            tier: 'paid',
            inputPerMTok: 1_000_000,
            outputPerMTok: 0,
            contentFingerprint: 'd'.repeat(64),
            snapshotId: 'snap-azure-rf',
          }),
      },
    );

    const refused = await service.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: 'hi',
        model: 'gpt-4o',
        idempotencyKey: 'op-azure-rf-json',
        responseFormat: { type: 'json_object' },
        extra: { max_tokens: 1 },
      },
      'key-1',
    );
    expect(refused.outcome).toBe('refused');
    if (refused.outcome === 'refused') {
      expect(refused.code).toBe(NATIVE_PRICING_UNAVAILABLE);
      expect(refused.message).toMatch(/response_format/);
    }
    expect(prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('M-FRAMING / M-FRAMING-PRIME / M-FRAMING-ROLE / M-FRAMING-SYS: exact Azure framing allowance', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
      PROVIDER_ACCESS: 'azure-openai',
    });
    // Exact Learn formula: empty user-only = 10; with system = 19.
    expect(azureOpenAiChatFramingTokenAllowance({})).toBe(10);
    expect(azureOpenAiChatFramingTokenAllowance({ systemPrompt: 'sys' })).toBe(19);

    const prepareProtectedReservation = vi.fn(async (params: Record<string, unknown>) => ({
      outcome: 'opened' as const,
      reservation: {
        reservationRef: '11111111-1111-4111-8111-111111111196',
        holdUsd: String(params.holdUsd),
        pricePolicyRevision: String(params.pricePolicyRevision),
      },
      intent: {},
    }));
    const service = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      new AzureOpenAiConnector(azureTestOptions()),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-4o',
            tier: 'paid',
            inputPerMTok: 1_000_000,
            outputPerMTok: 0,
            contentFingerprint: 'e'.repeat(64),
            snapshotId: 'snap-azure-framing',
          }),
      },
    );

    for (const prompt of ['', 'x'] as const) {
      prepareProtectedReservation.mockClear();
      const opened = await service.prepareProtectedReservation(
        'azure-openai',
        {
          prompt,
          model: 'gpt-4o',
          idempotencyKey: `op-azure-framing-${prompt.length}`,
          extra: { max_tokens: 1 },
        },
        'key-1',
      );
      expect(opened.outcome).toBe('opened');
      const holdUsd = Number(
        (prepareProtectedReservation.mock.calls[0][0] as { holdUsd: string }).holdUsd,
      );
      const contentOnly = protectedInputTokenUpperBound({ prompt });
      const framing = azureOpenAiChatFramingTokenAllowance({});
      expect(framing).toBe(10);
      expect(holdUsd).toBeGreaterThan(contentOnly);
      expect(holdUsd).toBeGreaterThanOrEqual(contentOnly + framing);
    }

    prepareProtectedReservation.mockClear();
    const withSys = await service.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: '',
        systemPrompt: 'sys',
        model: 'gpt-4o',
        idempotencyKey: 'op-azure-framing-sys',
        extra: { max_tokens: 1 },
      },
      'key-1',
    );
    expect(withSys.outcome).toBe('opened');
    const sysHold = Number(
      (prepareProtectedReservation.mock.calls[0][0] as { holdUsd: string }).holdUsd,
    );
    const sysContent = protectedInputTokenUpperBound({ prompt: '', systemPrompt: 'sys' });
    expect(azureOpenAiChatFramingTokenAllowance({ systemPrompt: 'sys' })).toBe(19);
    expect(sysHold).toBeGreaterThanOrEqual(sysContent + 19);
  });

  it('M-FRAMING-MODEL: out-of-set Azure model (gpt-35-turbo) refuses before hold', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
      PROVIDER_ACCESS: 'azure-openai',
    });
    const prepareProtectedReservation = vi.fn();
    const service = buildService(
      { prepareProtectedReservation },
      new AzureOpenAiConnector(azureTestOptions({ deployment: 'gpt-35-turbo' })),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-35-turbo',
            tier: 'paid',
            inputPerMTok: 10,
            outputPerMTok: 30,
            contentFingerprint: 'h'.repeat(64),
            snapshotId: 'snap-azure-oos',
          }),
      },
    );
    const refused = await service.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: 'hi',
        model: 'gpt-35-turbo',
        idempotencyKey: 'op-azure-oos',
        extra: { max_tokens: 8 },
      },
      'key-1',
    );
    expect(refused.outcome).toBe('refused');
    if (refused.outcome === 'refused') {
      expect(refused.code).toBe(PROTECTED_AZURE_FRAMING_MODEL_UNSUPPORTED);
      expect(refused.message).toMatch(/gpt-35-turbo/);
    }
    expect(prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('M-NONTEXT: unknown non-text ContentBlock refuses before hold/send', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
      PROVIDER_ACCESS: 'azure-openai',
    });
    const prepareProtectedReservation = vi.fn();
    const service = buildService(
      { prepareProtectedReservation },
      new AzureOpenAiConnector(azureTestOptions()),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-4o',
            tier: 'paid',
            inputPerMTok: 10,
            outputPerMTok: 30,
            contentFingerprint: 'i'.repeat(64),
            snapshotId: 'snap-azure-nontext',
          }),
      },
    );
    const refused = await service.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: [{ type: 'input_audio', text: 'nope' } as never],
        model: 'gpt-4o',
        idempotencyKey: 'op-azure-nontext',
        extra: { max_tokens: 8 },
      },
      'key-1',
    );
    // Assert the typed refusal before hold/send (do not kill via crash/TypeError).
    expect(refused).toBeDefined();
    expect(refused).toEqual(
      expect.objectContaining({
        outcome: 'refused',
        code: NATIVE_PRICING_UNAVAILABLE,
      }),
    );
    expect(String((refused as { message?: string }).message ?? '')).toMatch(/non-text/);
    expect(prepareProtectedReservation).not.toHaveBeenCalled();
  });

  it('M-EXTRAS-COUNT: protected Azure prepare with tools / tool_choice refuses before hold', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
      PROVIDER_ACCESS: 'azure-openai',
    });
    const prepareProtectedReservation = vi.fn(async (params: Record<string, unknown>) => ({
      outcome: 'opened' as const,
      reservation: {
        reservationRef: '11111111-1111-4111-8111-111111111195',
        holdUsd: String(params.holdUsd),
        pricePolicyRevision: String(params.pricePolicyRevision),
      },
      intent: {},
    }));
    const service = buildService(
      { prepareProtectedReservation: prepareProtectedReservation as never },
      new AzureOpenAiConnector(azureTestOptions()),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-4o',
            tier: 'paid',
            inputPerMTok: 1_000_000,
            outputPerMTok: 0,
            contentFingerprint: 'f'.repeat(64),
            snapshotId: 'snap-azure-tools',
          }),
      },
    );

    const without = await service.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: 'hello',
        model: 'gpt-4o',
        idempotencyKey: 'op-azure-tools-base',
        extra: { max_tokens: 8 },
      },
      'key-1',
    );
    expect(without.outcome).toBe('opened');
    expect(prepareProtectedReservation).toHaveBeenCalledTimes(1);

    const tools = [
      {
        type: 'function',
        function: {
          name: 'lookup',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      },
    ];
    const withTools = await service.prepareProtectedReservation(
      'azure-openai',
      {
        prompt: 'hello',
        model: 'gpt-4o',
        idempotencyKey: 'op-azure-tools-extra',
        extra: { max_tokens: 8, tools, tool_choice: 'auto' },
      },
      'key-1',
    );
    expect(withTools.outcome).toBe('refused');
    if (withTools.outcome === 'refused') {
      expect(withTools.code).toBe(NATIVE_PRICING_UNAVAILABLE);
      expect(withTools.message).toMatch(/tools|tool_choice/);
    }
    expect(prepareProtectedReservation).toHaveBeenCalledTimes(1);
  });

  it('M-EXTRAS-SVC: dropping extras record on admitted Azure refuses before hold/send', async () => {
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
      PROVIDER_ACCESS: 'azure-openai',
    });
    const prepareProtectedReservation = vi.fn();
    const service = buildService(
      { prepareProtectedReservation },
      new AzureOpenAiConnector(azureTestOptions()),
      {
        findAll: async () => [],
        findPricing: async () =>
          freshPricing({
            connector: 'azure-openai',
            model: 'gpt-4o',
            tier: 'paid',
            inputPerMTok: 10,
            outputPerMTok: 30,
            contentFingerprint: 'g'.repeat(64),
            snapshotId: 'snap-azure-extras-svc',
          }),
      },
    );

    const originalLookup = protectedForwardedExtrasAuthority.lookup.bind(
      protectedForwardedExtrasAuthority,
    );
    const spy = vi
      .spyOn(protectedForwardedExtrasAuthority, 'lookup')
      .mockImplementation((className) =>
        className === 'AzureOpenAiConnector' ? undefined : originalLookup(className),
      );
    try {
      const refused = await service.prepareProtectedReservation(
        'azure-openai',
        {
          prompt: 'hello',
          model: 'gpt-4o',
          idempotencyKey: 'op-azure-extras-svc',
          extra: { max_tokens: 16 },
        },
        'key-1',
      );
      expect(refused).toBeDefined();
      expect(refused.outcome).toBe('refused');
      expect(refused).toEqual(
        expect.objectContaining({
          outcome: 'refused',
          code: NATIVE_PRICING_UNAVAILABLE,
        }),
      );
      if (refused.outcome === 'refused') {
        expect(refused.message).toMatch(/without a reviewed extras record/);
      }
      expect(prepareProtectedReservation).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('empty PROTECTED_LAB_PROFILE disables protected routes (404 seam)', () => {
    const saved = process.env.PROTECTED_LAB_PROFILE;
    try {
      process.env.PROTECTED_LAB_PROFILE = '';
      validateEnv({
        ...BASE_ENV,
        PROTECTED_LAB_PROFILE: '',
        PROTECTED_LAB_CONNECTORS: 'mock',
      });
      const service = buildService({}, fencedMockConnector);
      expect(service.isProtectedLabProfileEnabled()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.PROTECTED_LAB_PROFILE;
      else process.env.PROTECTED_LAB_PROFILE = saved;
    }
  });
});

describe('M-EXEC: protected execute reservation mismatch', () => {
  const REF = '11111111-1111-4111-8111-111111111155';

  beforeEach(() => {
    process.env.PROVIDER_ACCESS = 'mock,azure-openai,perplexity';
    vi.clearAllMocks();
    clearTestNonBaseProtectedFence();
    installNonBaseFenceSpies();
    admitTestNonBaseProtectedFence('mock', { forwardsMaxTokens: true });
  });

  type CountingConnector = IConnector & { sendCount: () => number };

  function countingMock(name = 'mock'): CountingConnector {
    let sends = 0;
    return {
      name,
      supportsProtectedDispatchFence: true,
      type: 'api',
      execute: vi.fn(async (request: ConnectorRequest) => {
        const before = request.__beforeProviderFetch;
        if (typeof before === 'function') {
          await before({ requestUrl: `https://mock.test/${name}` });
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
      model: 'gpt-4o',
      idempotencyKey: 'op-azure-exec',
      extra: { max_tokens: 64 },
    });
    const azure = new AzureOpenAiConnector(azureTestOptions());
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

  it('M-EXEC-FP (b): Azure temperature added only at execute → mismatch, zero sends', async () => {
    // Perplexity is Stage-A excluded from the protected fence; keep the
    // fingerprint-divergence case on an admitted BaseApi class.
    const prepared = baseRequest({
      model: 'gpt-4o',
      idempotencyKey: 'op-azure-temp-exec',
      extra: { max_tokens: 64 },
    });
    const azure = new AzureOpenAiConnector(azureTestOptions());
    const executeSpy = vi.spyOn(azure, 'execute');
    await expectMismatch({
      connector: azure,
      connectorName: 'azure-openai',
      prepared,
      executeRequest: {
        ...prepared,
        extra: { max_tokens: 64, temperature: 0.9 },
      },
      sendCount: () => executeSpy.mock.calls.length,
    });
  });

  it('M-EXEC-PROVIDER: matching fingerprint but different providerName → mismatch, zero sends', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'mock',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const connector = countingMock();
    const prepared = baseRequest();
    const {
      intent,
      reservation,
      billing,
      settleIntentInTx,
      releaseIntent,
      commitProtectedDispatch,
      markProtectedUnknown,
    } = openHold('mock', prepared);
    // Fingerprint matches the execute request; only providerName diverges.
    reservation.providerName = 'other-provider';
    const service = buildService(billing, connector);
    const response = await service.execute('mock', prepared as never, 'key-1');
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe('protected_reservation_mismatch');
    expect(connector.sendCount()).toBe(0);
    expect(intent.protectedPhase).toBe('reserved');
    expect(settleIntentInTx).not.toHaveBeenCalled();
    expect(releaseIntent).not.toHaveBeenCalled();
    expect(commitProtectedDispatch).not.toHaveBeenCalled();
    expect(markProtectedUnknown).not.toHaveBeenCalled();
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
    const row = freshPricing({
      connector: 'mock',
      model: 'm',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: 'p'.repeat(64),
      snapshotId: 'snap-p9-pos',
    });
    const routeKey = 'connectors/mock/protected/execute';
    const revision = deriveProtectedPricePolicyRevision(row as never, routeKey);
    const { intent, reservation, billing, commitProtectedDispatch, settleIntentInTx } = openHold(
      'mock',
      prepared,
    );
    reservation.routeKey = routeKey;
    reservation.pricePolicyRevision = revision;
    const service = buildService(billing, connector, {
      findAll: async () => [],
      findPricing: async () => row,
    });
    const response = await service.execute('mock', prepared as never, 'key-1');
    expect(response.status).toBe('success');
    expect(connector.sendCount()).toBe(1);
    expect(commitProtectedDispatch).toHaveBeenCalled();
    expect(intent.protectedPhase).not.toBe('reserved');
    expect(settleIntentInTx).toHaveBeenCalled();
  });
});

describe('P9: pre-fetch price/route recheck', () => {
  const REF = '11111111-1111-4111-8111-111111111166';

  beforeEach(() => {
    process.env.PROVIDER_ACCESS = 'mock,azure-openai';
    vi.clearAllMocks();
    clearTestNonBaseProtectedFence();
    installNonBaseFenceSpies();
    admitTestNonBaseProtectedFence('mock', { forwardsMaxTokens: true });
  });

  function countingMock(): IConnector & { sendCount: () => number } {
    let sends = 0;
    return {
      name: 'mock',
      supportsProtectedDispatchFence: true,
      type: 'api',
      execute: vi.fn(async (request: ConnectorRequest) => {
        const before = request.__beforeProviderFetch;
        if (typeof before === 'function') {
          await before({ requestUrl: 'https://mock.test/p9' });
        }
        sends += 1;
        return {
          id: 'mock-1',
          connector: 'mock',
          model: 'm',
          result: 'ok',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
          latencyMs: 1,
          status: 'success' as const,
        };
      }),
      getCapabilities: () => ({
        name: 'mock',
        type: 'api' as const,
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
        rateLimitStatus: 'ok' as const,
      }),
      resetCircuitBreaker: () => [],
      sendCount: () => sends,
    };
  }

  function preparedRequest() {
    return {
      prompt: 'hello',
      model: 'm',
      protectedProfile: true as const,
      reservationRef: REF,
      idempotencyKey: 'op-p9',
      extra: { max_tokens: 64 } as Record<string, unknown>,
    };
  }

  function openP9Hold(row: Record<string, unknown>, routeKey: string) {
    const prepared = preparedRequest();
    const revision = deriveProtectedPricePolicyRevision(row as never, routeKey);
    const intent = {
      id: 'intent-p9',
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
      payloadFingerprint: ConnectorsService['requestFingerprint']('mock', prepared as never),
      providerName: 'mock',
      modelName: 'm',
      routeKey,
      pricePolicyRevision: revision,
      holdUsd: '1.25',
      amountUnit: 'USD',
      amountPrecision: 6,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      generation: 1,
      protectedPhase: 'reserved' as const,
      lifecycleVersion: 1 as const,
    };
    const commitProtectedDispatch = vi.fn(async (handle: RequestIntentHandle) => {
      handle.protectedPhase = 'dispatch_committed';
      return true;
    });
    const markProtectedUnknown = vi.fn(async () => true);
    const releaseIntent = vi.fn(async () => false);
    const settleIntentInTx = vi.fn(async () => true);
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
      prepared,
      intent,
      reservation,
      billing,
      commitProtectedDispatch,
      markProtectedUnknown,
      releaseIntent,
      settleIntentInTx,
      row,
      routeKey,
      revision,
    };
  }

  it('P9-01: price revision change between prepare and hook refuses with zero sends', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'mock',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const baseRow = freshPricing({
      connector: 'mock',
      model: 'm',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: 'a'.repeat(64),
      snapshotId: 'snap-p9-01a',
    });
    const routeKey = 'connectors/mock/protected/execute';
    const ctx = openP9Hold(baseRow, routeKey);
    const changedRow = freshPricing({
      ...baseRow,
      contentFingerprint: 'b'.repeat(64),
      snapshotId: 'snap-p9-01b',
      inputPerMTok: 99,
    });
    const connector = countingMock();
    const service = buildService(ctx.billing, connector, {
      findAll: async () => [],
      findPricing: async () => changedRow,
    });
    const response = await service.execute('mock', ctx.prepared as never, 'key-1');
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe(PROTECTED_RESERVATION_STALE);
    expect(connector.sendCount()).toBe(0);
    expect(ctx.commitProtectedDispatch).not.toHaveBeenCalled();
    expect(ctx.intent.protectedPhase).toBe('reserved');
    expect(ctx.releaseIntent).not.toHaveBeenCalled();
    expect(ctx.markProtectedUnknown).not.toHaveBeenCalled();
  });

  function openAzureP9Hold(params: {
    row: Record<string, unknown>;
    target: AzureProtectedEffectiveTarget;
    options: {
      endpoint?: string;
      deployment?: string;
      apiVersion?: string;
      apiKey?: string;
    };
  }) {
    const prepared = {
      prompt: 'hello',
      model: 'gpt-4o',
      protectedProfile: true as const,
      reservationRef: REF,
      idempotencyKey: 'op-p9-azure',
      extra: { max_tokens: 64 } as Record<string, unknown>,
    };
    const routeKey = encodeAzureTargetIntoRouteKey(
      'connectors/azure-openai/protected/execute',
      params.target,
    );
    const revision = deriveProtectedPricePolicyRevision(params.row as never, routeKey);
    const intent = {
      id: 'intent-p9-az',
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
      payloadFingerprint: ConnectorsService['requestFingerprint'](
        'azure-openai',
        prepared as never,
      ),
      providerName: 'azure-openai',
      modelName: 'gpt-4o',
      routeKey,
      pricePolicyRevision: revision,
      holdUsd: '1.25',
      amountUnit: 'USD',
      amountPrecision: 6,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      generation: 1,
      protectedPhase: 'reserved' as const,
      lifecycleVersion: 1 as const,
    };
    const commitProtectedDispatch = vi.fn(async () => true);
    const markProtectedUnknown = vi.fn(async () => true);
    const releaseIntent = vi.fn(async () => false);
    const billing = {
      lookupProtectedReservation: vi.fn(async () => ({
        outcome: 'found' as const,
        reservation,
        intent,
      })),
      commitProtectedDispatch,
      markProtectedUnknown,
      releaseIntent,
      settleIntentInTx: vi.fn(async () => true),
      settleInTx: vi.fn(),
      releaseIntentInTx: vi.fn(),
    };
    const opts = { ...params.options };
    const azure = new AzureOpenAiConnector(opts);
    let executeEntered = 0;
    const realExecute = azure.execute.bind(azure);
    azure.execute = (async (request: ConnectorRequest) => {
      executeEntered += 1;
      return realExecute(request);
    }) as typeof azure.execute;
    return {
      prepared,
      intent,
      reservation,
      billing,
      commitProtectedDispatch,
      markProtectedUnknown,
      releaseIntent,
      azure,
      opts,
      executeEntered: () => executeEntered,
      routeKey,
      row: params.row,
    };
  }

  it('P9-02: Azure deployment / route change between prepare and hook refuses', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'azure-openai',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
    });
    const row = freshPricing({
      connector: 'azure-openai',
      model: 'gpt-4o',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: 'c'.repeat(64),
      snapshotId: 'snap-p9-02',
    });
    const ctx = openAzureP9Hold({
      row,
      target: azureTestTarget(),
      // Deployment changed after prepare → binding/route diverges at P9 recheck.
      options: azureTestOptions({ deployment: 'gpt-4o-mini' }),
    });
    const service = buildService(ctx.billing, ctx.azure, {
      findAll: async () => [],
      findPricing: async () => row,
    });
    const response = await service.execute('azure-openai', ctx.prepared as never, 'key-1');
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe(PROTECTED_RESERVATION_STALE);
    expect(ctx.commitProtectedDispatch).not.toHaveBeenCalled();
    expect(ctx.intent.protectedPhase).toBe('reserved');
    expect(ctx.releaseIntent).not.toHaveBeenCalled();
    expect(ctx.markProtectedUnknown).not.toHaveBeenCalled();
    expect(ctx.executeEntered()).toBe(1); // execute entered; fetch blocked by stale throw
  });

  it('P9-03: catalogue unreadable / unauthoritative between prepare and hook refuses', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'mock',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const baseRow = freshPricing({
      connector: 'mock',
      model: 'm',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: 'd'.repeat(64),
      snapshotId: 'snap-p9-03',
    });
    const routeKey = 'connectors/mock/protected/execute';
    const ctx = openP9Hold(baseRow, routeKey);
    const connector = countingMock();
    const service = buildService(ctx.billing, connector, {
      findAll: async () => [],
      findPricing: async () => {
        throw new Error('catalogue offline');
      },
    });
    const response = await service.execute('mock', ctx.prepared as never, 'key-1');
    expect(response.status).toBe('error');
    expect(response.error?.type).toBe(PROTECTED_RESERVATION_STALE);
    expect(connector.sendCount()).toBe(0);
    expect(ctx.commitProtectedDispatch).not.toHaveBeenCalled();
    expect(ctx.intent.protectedPhase).toBe('reserved');
    expect(ctx.markProtectedUnknown).not.toHaveBeenCalled();
  });

  it('P9-05: unchanged proof executes once and settles', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'mock',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'mock',
    });
    const baseRow = freshPricing({
      connector: 'mock',
      model: 'm',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: 'e'.repeat(64),
      snapshotId: 'snap-p9-05',
    });
    const routeKey = 'connectors/mock/protected/execute';
    const ctx = openP9Hold(baseRow, routeKey);
    const connector = countingMock();
    const service = buildService(ctx.billing, connector, {
      findAll: async () => [],
      findPricing: async () => baseRow,
    });
    const response = await service.execute('mock', ctx.prepared as never, 'key-1');
    expect(response.status).toBe('success');
    expect(connector.sendCount()).toBe(1);
    expect(ctx.commitProtectedDispatch).toHaveBeenCalled();
    expect(ctx.intent.protectedPhase).not.toBe('reserved');
    expect(ctx.settleIntentInTx).toHaveBeenCalled();
  });

  it('P9-06: Azure endpoint/origin change between prepare and hook refuses with zero sends', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'azure-openai',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
    });
    const row = freshPricing({
      connector: 'azure-openai',
      model: 'gpt-4o',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: 'f'.repeat(64),
      snapshotId: 'snap-p9-06',
    });
    const ctx = openAzureP9Hold({
      row,
      target: azureTestTarget(),
      options: azureTestOptions({ endpoint: 'https://other-resource.openai.azure.com' }),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    } as Response);
    try {
      const service = buildService(ctx.billing, ctx.azure, {
        findAll: async () => [],
        findPricing: async () => row,
      });
      const response = await service.execute('azure-openai', ctx.prepared as never, 'key-1');
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe(PROTECTED_RESERVATION_STALE);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.commitProtectedDispatch).not.toHaveBeenCalled();
      expect(ctx.intent.protectedPhase).toBe('reserved');
      expect(ctx.releaseIntent).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('P9-07: Azure API version change between prepare and hook refuses with zero sends', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'azure-openai',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
    });
    const row = freshPricing({
      connector: 'azure-openai',
      model: 'gpt-4o',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: 'g'.repeat(64),
      snapshotId: 'snap-p9-07',
    });
    const ctx = openAzureP9Hold({
      row,
      target: azureTestTarget(),
      options: azureTestOptions({ apiVersion: '2025-01-01-preview' }),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    } as Response);
    try {
      const service = buildService(ctx.billing, ctx.azure, {
        findAll: async () => [],
        findPricing: async () => row,
      });
      const response = await service.execute('azure-openai', ctx.prepared as never, 'key-1');
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe(PROTECTED_RESERVATION_STALE);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.commitProtectedDispatch).not.toHaveBeenCalled();
      expect(ctx.intent.protectedPhase).toBe('reserved');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('P9-08: origin change during awaited header step (after URL build) refuses with zero sends', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'azure-openai',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
    });
    const row = freshPricing({
      connector: 'azure-openai',
      model: 'gpt-4o',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: 'h'.repeat(64),
      snapshotId: 'snap-p9-08',
    });
    const ctx = openAzureP9Hold({
      row,
      target: azureTestTarget(),
      options: azureTestOptions(),
    });
    const originalHeaders = (
      ctx.azure as unknown as {
        getRequestHeaders: (request: ConnectorRequest) => Promise<Record<string, string>>;
      }
    ).getRequestHeaders.bind(ctx.azure);
    (
      ctx.azure as unknown as {
        getRequestHeaders: (request: ConnectorRequest) => Promise<Record<string, string>>;
      }
    ).getRequestHeaders = async (request: ConnectorRequest) => {
      // URL already built from the reserved origin; mutate config before the P9 hook.
      ctx.opts.endpoint = 'https://switched.openai.azure.com';
      return originalHeaders(request);
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    } as Response);
    try {
      const service = buildService(ctx.billing, ctx.azure, {
        findAll: async () => [],
        findPricing: async () => row,
      });
      const response = await service.execute('azure-openai', ctx.prepared as never, 'key-1');
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe(PROTECTED_RESERVATION_STALE);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.commitProtectedDispatch).not.toHaveBeenCalled();
      expect(ctx.intent.protectedPhase).toBe('reserved');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('M-P9-TARGET-CONCEPT: actual URL mismatch refuses even when re-derived config still matches', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'azure-openai',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
    });
    const row = freshPricing({
      connector: 'azure-openai',
      model: 'gpt-4o',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: 'i'.repeat(64),
      snapshotId: 'snap-p9-target-concept',
    });
    const ctx = openAzureP9Hold({
      row,
      target: azureTestTarget(),
      options: azureTestOptions(),
    });
    // Config still matches the reservation, but the pre-built URL does not —
    // kills a mutant that only re-derives and never compares the actual URL.
    (
      ctx.azure as unknown as {
        buildRequestUrl: (request: ConnectorRequest) => string;
      }
    ).buildRequestUrl = () =>
      buildAzureOpenAiChatCompletionsUrl(
        azureTestTarget({ origin: 'https://concept-mutant.openai.azure.com' }),
      );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    } as Response);
    try {
      const service = buildService(ctx.billing, ctx.azure, {
        findAll: async () => [],
        findPricing: async () => row,
      });
      const response = await service.execute('azure-openai', ctx.prepared as never, 'key-1');
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe(PROTECTED_RESERVATION_STALE);
      expect(response.error?.message).toMatch(/actual request URL/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.commitProtectedDispatch).not.toHaveBeenCalled();
      expect(ctx.intent.protectedPhase).toBe('reserved');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  /**
   * A→B→A through BaseApiConnector.execute:
   * - A at prepare (openAzureP9Hold)
   * - B while buildRequestUrl runs (URL carries B)
   * - A restored inside the awaited header step before __beforeProviderFetch
   * So (c) price/route re-resolution matches reserved A, and only (b) actual-URL
   * comparison refuses. Kills M-EQ-APIVER / M-EQ-DEPLOY / M-HOOK-REBUILD.
   */
  function installAzureAToBToASchedule(
    ctx: { azure: AzureOpenAiConnector; opts: Record<string, string | undefined> },
    field: 'endpoint' | 'apiVersion' | 'deployment',
    valueB: string,
  ): void {
    const valueA = String(ctx.opts[field]);
    const azure = ctx.azure as unknown as {
      buildRequestUrl: (request: ConnectorRequest) => string;
      getRequestHeaders: (request: ConnectorRequest) => Promise<Record<string, string>>;
    };
    const originalBuild = azure.buildRequestUrl.bind(ctx.azure);
    const originalHeaders = azure.getRequestHeaders.bind(ctx.azure);
    // One-shot: only the first execute-time buildRequestUrl flips A→B.
    // A later rebuild (M-HOOK-REBUILD) must see restored A, otherwise the
    // mutant is masked by the test harness itself.
    let buildCount = 0;
    azure.buildRequestUrl = (request: ConnectorRequest) => {
      buildCount += 1;
      if (buildCount === 1) {
        ctx.opts[field] = valueB;
      }
      return originalBuild(request);
    };
    azure.getRequestHeaders = async (request: ConnectorRequest) => {
      const headers = await originalHeaders(request);
      // Restore A after the header await, before __beforeProviderFetch.
      ctx.opts[field] = valueA;
      return headers;
    };
  }

  async function expectAzureUrlCheckStaleAToBToA(params: {
    snapshotId: string;
    field: 'endpoint' | 'apiVersion' | 'deployment';
    valueB: string;
  }): Promise<void> {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'azure-openai',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
    });
    const row = freshPricing({
      connector: 'azure-openai',
      model: 'gpt-4o',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: params.snapshotId
        .replace(/[^a-f0-9]/gi, 'a')
        .padEnd(64, 'a')
        .slice(0, 64),
      snapshotId: params.snapshotId,
    });
    const ctx = openAzureP9Hold({
      row,
      target: azureTestTarget(),
      options: azureTestOptions(),
    });
    installAzureAToBToASchedule(ctx, params.field, params.valueB);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    } as Response);
    try {
      const service = buildService(ctx.billing, ctx.azure, {
        findAll: async () => [],
        findPricing: async () => row,
      });
      const response = await service.execute('azure-openai', ctx.prepared as never, 'key-1');
      expect(response.status).toBe('error');
      expect(response.error?.type).toBe(PROTECTED_RESERVATION_STALE);
      // Discriminate (b) actual-URL check from (c) price/route re-resolution.
      expect(response.error?.message).toMatch(/actual request URL/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.commitProtectedDispatch).not.toHaveBeenCalled();
      expect(ctx.intent.protectedPhase).toBe('reserved');
      expect(ctx.releaseIntent).not.toHaveBeenCalled();
      expect(ctx.markProtectedUnknown).not.toHaveBeenCalled();
      // Original key remains; hold was never released.
      expect(ctx.reservation.operationKey).toBe(String(ctx.prepared.idempotencyKey));
    } finally {
      fetchSpy.mockRestore();
    }
  }

  it('P9-09: A→B→A origin flip across header await refuses on actual URL check', async () => {
    await expectAzureUrlCheckStaleAToBToA({
      snapshotId: 'snap-p9-09-origin',
      field: 'endpoint',
      valueB: 'https://flip-origin.openai.azure.com',
    });
  });

  it('P9-10: A→B→A apiVersion flip across header await refuses on actual URL check', async () => {
    await expectAzureUrlCheckStaleAToBToA({
      snapshotId: 'snap-p9-10-apiver',
      field: 'apiVersion',
      valueB: '2025-04-01-preview',
    });
  });

  it('P9-11: A→B→A configured deployment flip across header await refuses on actual URL check', async () => {
    // Reachable via configured options.deployment (not request.extra.deployment).
    // Prepare's M-AZURE-DEPLOY-BIND only runs at prepare; openAzureP9Hold already
    // reserved deployment A (== priced model). Flipping opts.deployment A→B→A
    // during execute reaches azureProtectedTargetsEqual's deployment clause.
    await expectAzureUrlCheckStaleAToBToA({
      snapshotId: 'snap-p9-11-deploy',
      field: 'deployment',
      valueB: 'gpt-4o-mini',
    });
  });

  it('P9-12: protected Azure fetch uses redirect:error; legacy Azure keeps follow', async () => {
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'azure-openai',
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'azure-openai',
    });
    const row = freshPricing({
      connector: 'azure-openai',
      model: 'gpt-4o',
      tier: 'paid',
      inputPerMTok: 10,
      outputPerMTok: 30,
      contentFingerprint: 'j'.repeat(64),
      snapshotId: 'snap-p9-12-redirect',
    });
    const ctx = openAzureP9Hold({
      row,
      target: azureTestTarget(),
      options: azureTestOptions(),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
    } as Response);
    try {
      const service = buildService(ctx.billing, ctx.azure, {
        findAll: async () => [],
        findPricing: async () => row,
      });
      const response = await service.execute('azure-openai', ctx.prepared as never, 'key-1');
      expect(response.status).toBe('success');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: 'error' }));
    } finally {
      fetchSpy.mockRestore();
    }

    // Legacy / unprotected Azure execute keeps getRedirectPolicy() === 'follow'.
    validateEnv({
      ...BASE_ENV,
      PROVIDER_ACCESS: 'azure-openai',
      PROTECTED_LAB_PROFILE: 'false',
      PROTECTED_LAB_CONNECTORS: '',
    });
    const legacyAzure = new AzureOpenAiConnector(azureTestOptions());
    const legacyFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'y' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: 'y' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
    } as Response);
    try {
      const legacy = await legacyAzure.execute({
        prompt: 'hello',
        model: 'gpt-4o',
      });
      expect(legacy.status).toBe('success');
      expect(legacyFetch).toHaveBeenCalledTimes(1);
      expect(legacyFetch.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ redirect: 'follow' }),
      );
    } finally {
      legacyFetch.mockRestore();
    }
  });
});

describe('protected Lab production test-seam isolation', () => {
  beforeEach(() => {
    // Drop spies left by other describes so production lookups are measured.
    vi.restoreAllMocks();
    clearTestNonBaseProtectedFence();
  });

  it('negative: production fence module exports no __testOnly mutator; table mutate throws; non-Base refused', async () => {
    const mod = await import('./protected-dispatch-fence-admission');
    expect('__testOnlyAdmitNonBaseProtectedFence' in mod).toBe(false);
    expect('__testOnlyClearNonBaseProtectedFence' in mod).toBe(false);
    // Mutating the exported Set view must not affect the production lookup,
    // which reads only the frozen empty admissions array.
    (mod.PROTECTED_NON_BASE_FENCE_ADMISSIONS as Set<string>).add('evil');
    expect(mod.PROTECTED_NON_BASE_FENCE_ADMISSIONS.has('evil')).toBe(true);
    expect(mod.isNonBaseProtectedFenceAdmitted('evil')).toBe(false);
    expect(mod.isNonBaseProtectedFenceAdmitted('mock')).toBe(false);
    // Frozen extras records reject mutation attempts.
    const extras = await import('../billing/protected-forwarded-extras');
    expect(Object.isFrozen(extras.PROTECTED_FORWARDED_EXTRA_RECORDS)).toBe(true);
    expect(() => {
      (extras.PROTECTED_FORWARDED_EXTRA_RECORDS as unknown as unknown[]).push({});
    }).toThrow();

    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'rogue-seam',
      PROVIDER_ACCESS: 'rogue-seam',
    });
    const rogue: IConnector = {
      name: 'rogue-seam',
      supportsProtectedDispatchFence: true,
      type: 'api',
      execute: vi.fn(async () => {
        throw new Error('rogue-seam must not execute');
      }),
      getCapabilities: () => ({
        name: 'rogue-seam',
        type: 'api',
        models: ['m'],
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
        maxTimeout: 30_000,
      }),
      getStatus: async () => ({
        name: 'rogue-seam',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      }),
      resetCircuitBreaker: () => [],
    };
    const service = buildService({}, rogue);
    expect(service.connectorSupportsProtectedDispatchFence('rogue-seam')).toBe(false);
  });

  it('negative: production extras module exports no __testOnly mutator; records frozen', async () => {
    const mod = await import('../billing/protected-forwarded-extras');
    expect('__testOnlyWithoutExtrasRecord' in mod).toBe(false);
    expect(Object.isFrozen(mod.PROTECTED_FORWARDED_EXTRA_RECORDS)).toBe(true);
  });

  it('import-ban: no non-spec src file imports or exports __testOnly*', async () => {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      'rg',
      ['-n', '__testOnly', 'src', '--glob', '!**/*.spec.ts', '--glob', '!**/*.test.ts'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    // rg exit 1 = no matches (desired); exit 0 with stdout = ban violated.
    expect(result.status === 1 || (result.status === 0 && !(result.stdout || '').trim())).toBe(
      true,
    );
    expect((result.stdout || '').trim()).toBe('');
  });

  it('positive mock: non-Base class admitted via vi.spyOn lookup passes the fence check', () => {
    clearTestNonBaseProtectedFence();
    installNonBaseFenceSpies();
    admitTestNonBaseProtectedFence('spy-mock', { forwardsMaxTokens: true });
    validateEnv({
      ...BASE_ENV,
      PROTECTED_LAB_PROFILE: 'true',
      PROTECTED_LAB_CONNECTORS: 'spy-mock',
      PROVIDER_ACCESS: 'spy-mock',
    });
    const spyMock: IConnector = {
      name: 'spy-mock',
      supportsProtectedDispatchFence: true,
      type: 'api',
      execute: vi.fn(),
      getCapabilities: () => ({
        name: 'spy-mock',
        type: 'api',
        models: ['m'],
        supportsStreaming: false,
        supportsJsonSchema: false,
        supportsTools: false,
        maxTimeout: 30_000,
      }),
      getStatus: async () => ({
        name: 'spy-mock',
        healthy: true,
        activeJobs: 0,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      }),
      resetCircuitBreaker: () => [],
    };
    const service = buildService({}, spyMock);
    expect(service.connectorSupportsProtectedDispatchFence('spy-mock')).toBe(true);
  });
});

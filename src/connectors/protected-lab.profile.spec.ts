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
import type { ConnectorRequest, IConnector } from './interfaces/connector.interface';
import type { RequestIntentHandle } from '../billing/billing.service';
import { validateEnv } from '../config/env.schema';
import { BadRequestException } from '@nestjs/common';

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

function buildService(billing: Partial<BillingService>, connector: IConnector): ConnectorsService {
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
    { findAll: async () => [] },
    null,
    undefined,
    undefined,
    billing as BillingService,
  );
  service.register(connector);
  return service;
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
});

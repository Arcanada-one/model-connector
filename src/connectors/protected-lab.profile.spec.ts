/**
 * Protected Lab profile guards on ConnectorsService.execute (unit, mocked connector).
 *
 * Named mutation evidence for new code: see REPORT.md (MUTATION-P1 / MUTATION-P11).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';

import { ConnectorsService } from './connectors.service';
import type { BillingService } from '../billing/billing.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { MetricsService } from '../metrics/metrics.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import { ModalityCatalogService } from './modality-catalog.service';
import type { IConnector } from './interfaces/connector.interface';

function buildService(billing: Partial<BillingService>, connector: IConnector): ConnectorsService {
  const service = new ConnectorsService(
    { add: vi.fn() } as unknown as Queue,
    {} as unknown as PrismaService,
    { observe: vi.fn() } as unknown as MetricsService,
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

const mockConnector: IConnector = {
  name: 'mock',
  execute: vi.fn(async () => {
    throw new Error('provider must not be called');
  }),
  getCapabilities: () => ({
    models: ['m'],
    supportsStreaming: false,
    supportsJsonSchema: false,
    supportsTools: false,
  }),
} as unknown as IConnector;

describe('protected Lab profile execute guards', () => {
  beforeEach(() => {
    // Bare name = read+use. `mock:read,use` would parse as mock:read AND a
    // separate provider literally named "use".
    process.env.PROVIDER_ACCESS = 'mock';
    vi.clearAllMocks();
  });

  it('P1: protected execute without reservation_ref refuses null-intent/dark fallback', async () => {
    const billing = {
      lookupProtectedReservation: vi.fn(),
      releaseIntent: vi.fn(),
    };
    const service = buildService(billing, mockConnector);

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
    service.register(mockConnector);

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
    const service = buildService(billing, mockConnector);

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
});

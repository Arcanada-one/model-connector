import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MetricsService } from '../../metrics/metrics.service';
import type { BillingService } from '../../billing/billing.service';
import { validateEnv } from '../../config/env.schema';
import { ConnectorsService } from '../connectors.service';
import { CascadeRouterService } from '../cascade/cascade-router.service';
import { executeRequestSchema, perConnectorExecuteSchema } from '../dto/execute.dto';
import { OutputGuardMiddleware } from '../output-guard/output-guard.middleware';
import { DeepSeekConnector } from './deepseek.connector';

const fixtureEnv = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://fixture:fixture@localhost:5432/offline',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PREFIX: 'offline:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_TIMEOUT_MS: '300000',
  CONNECTOR_MAX_CONCURRENCY: '1',
  STT_GROQ_API_KEY: 'offline-sentinel',
  // This is a deterministic offline route fixture, not a price claim.
  CASCADE_LOW_REASONING_ORDER: 'deepseek:deepseek-flash:free',
};
const measurement = {
  version: 'first-dispatch-measurement/v0' as const,
  corpusId: 'offline',
  caseId: 'malformed-options',
  roleId: 'offline',
  taskClassId: 'offline',
  commandId: 'offline',
  replayIndex: 1,
  variant: 'baseline' as const,
  adapterBoundary: 'arcana-agent-system/driver/first-dispatch-v0' as const,
};
const invalid = [
  { thinking: null },
  { thinking: { type: 'unknown' } },
  { thinking: { type: 'disabled', unexpected: true } },
  { thinking: { type: 'disabled' }, reasoning_effort: 'high' },
];

describe('DeepSeek resolved-provider prefinancial boundary (offline)', () => {
  let service: ConnectorsService;
  let cascade: CascadeRouterService;
  let billing: { openIntent: ReturnType<typeof vi.fn> };
  let observations: { create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    validateEnv({ ...fixtureEnv, BILLING_ENFORCED: 'true' });
    vi.stubEnv('DEEPSEEK_API_KEY', 'offline-sentinel');
    vi.stubEnv('PROVIDER_ACCESS', '');
    billing = { openIntent: vi.fn().mockResolvedValue({ outcome: 'in_flight' }) };
    observations = {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const metrics = { record: vi.fn(), recordCascade: vi.fn() };
    service = new ConnectorsService(
      { add: vi.fn() } as unknown as Queue,
      { firstDispatchObservation: observations } as unknown as PrismaService,
      metrics as unknown as MetricsService,
      new OutputGuardMiddleware({ enabled: false, maxRetries: 0, timeoutMs: 5000 }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      billing as unknown as BillingService,
    );
    service.register(new DeepSeekConnector());
    cascade = new CascadeRouterService(service, metrics as unknown as MetricsService);
    fetchSpy = vi.fn().mockRejectedValue(new Error('Unexpected offline transport'));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    validateEnv({ ...fixtureEnv, BILLING_ENFORCED: 'false' });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(invalid)('per-connector refuses before Billing intent: %j', async (extra) => {
    const request = perConnectorExecuteSchema.parse({ prompt: 'offline', extra });
    const response = await service.execute(
      'deepseek',
      {
        ...request,
        idempotencyKey: 'offline-owned-intent',
        firstDispatchMeasurement: measurement,
      },
      'offline-key',
    );
    expect(response.error?.type).toBe('validation_error');
    expect(billing.openIntent).not.toHaveBeenCalled();
    expect(observations.create).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(invalid)(
    'real profile resolves DeepSeek then refuses before Billing: %j',
    async (extra) => {
      const { profile, ...request } = executeRequestSchema.parse({
        profile: 'low-reasoning',
        prompt: 'offline',
        extra,
      });
      await expect(cascade.execute(profile!, request, 'offline-key')).rejects.toMatchObject({
        tried: [{ connector: 'deepseek', model: 'deepseek-flash', errorType: 'validation_error' }],
      });
      expect(billing.openIntent).not.toHaveBeenCalled();
      expect(observations.create).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('valid resolved options reach the real enforced Billing seam', async () => {
    const response = await service.execute(
      'deepseek',
      {
        prompt: 'offline',
        extra: { thinking: { type: 'enabled' } },
      },
      'offline-key',
    );
    expect(response.error?.type).toBe('idempotency_conflict');
    expect(billing.openIntent).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('invalid options refuse observation reservation when Billing is dark', async () => {
    validateEnv({ ...fixtureEnv, BILLING_ENFORCED: 'false' });
    const request = perConnectorExecuteSchema.parse({
      prompt: 'offline',
      extra: { thinking: null },
      firstDispatchMeasurement: measurement,
    });
    const response = await service.execute('deepseek', request, 'offline-key');
    expect(response.error?.type).toBe('validation_error');
    expect(observations.create).not.toHaveBeenCalled();
    expect(billing.openIntent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('valid options reach observation reservation when Billing is dark', async () => {
    validateEnv({ ...fixtureEnv, BILLING_ENFORCED: 'false' });
    observations.create.mockRejectedValueOnce(new Error('Offline reservation boundary'));
    await expect(
      service.execute(
        'deepseek',
        {
          prompt: 'offline',
          firstDispatchMeasurement: measurement,
          extra: { thinking: { type: 'disabled' } },
        },
        'offline-key',
      ),
    ).rejects.toThrow('Offline reservation boundary');
    expect(observations.create).toHaveBeenCalledTimes(1);
    expect(billing.openIntent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

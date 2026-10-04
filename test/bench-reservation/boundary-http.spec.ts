import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { getQueueToken } from '@nestjs/bullmq';
import { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { AuthGuard } from '../../src/auth/auth.guard';
import { AuthService } from '../../src/auth/auth.service';
import { AdminController } from '../../src/admin/admin.controller';
import { AdminService } from '../../src/admin/admin.service';
import { CircuitBreakerAdminController } from '../../src/admin/circuit-breaker.controller';
import { WatcherRepairController } from '../../src/admin/watcher-repair.controller';
import { CreditsController } from '../../src/billing/credits.controller';
import { PaymentsController } from '../../src/billing/payments.controller';
import { BillingService } from '../../src/billing/billing.service';
import { PAYMENTS_PRINCIPAL } from '../../src/billing/payments-principal.guard';
import { BillingReconcilerService } from '../../src/billing/reconciler.service';
import { ConnectorsController } from '../../src/connectors/connectors.controller';
import { ConnectorsService } from '../../src/connectors/connectors.service';
import { ImageGenerationService } from '../../src/connectors/image-generation/image-generation.service';
import { CascadeRouterService } from '../../src/connectors/cascade/cascade-router.service';
import { ImageJobController } from '../../src/connectors/image-generation/jobs/image-job.controller';
import { HealthController } from '../../src/health/health.controller';
import { MetricsService } from '../../src/metrics/metrics.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OpenAiCompatController } from '../../src/openai-compat/openai-compat.controller';
import { FailoverRouterService } from '../../src/connectors/failover/failover-router.service';
import { PromptCachePrewarmController } from '../../src/prompt-cache/prompt-cache-prewarm.controller';
import { SpeechController } from '../../src/speech/speech.controller';
import { SpeechService } from '../../src/speech/speech.service';
import { SpeechMetricsService } from '../../src/speech/speech-metrics.service';
import { SttRouterService } from '../../src/speech/stt/stt-router.service';
import { SttAsyncController } from '../../src/speech/stt/stt-async.controller';
import { SttQuotaService } from '../../src/speech/stt/stt-quota.service';

// Only an owned source HTTP contour: no AppModule, bootstrap, provider service,
// databases, Redis, live credentials, caller identity or reservation is started.
// Actual controllers/guards execute. Explicit inert downstream values cannot
// execute any paid/model path. This is refusal/registration evidence only.
const controllers = [
  AdminController,
  CircuitBreakerAdminController,
  WatcherRepairController,
  CreditsController,
  PaymentsController,
  ConnectorsController,
  ImageJobController,
  HealthController,
  OpenAiCompatController,
  PromptCachePrewarmController,
  SpeechController,
  SttAsyncController,
];

type Case = readonly [method: string, path: string, status: number];
export const boundaryCases: readonly Case[] = [
  ['DELETE', '/admin/keys/owned-fixture', 403],
  ['GET', '/admin/credits/owned-fixture', 403],
  ['GET', '/admin/credits/owned-fixture/history', 403],
  ['GET', '/admin/keys', 403],
  ['GET', '/connectors', 401],
  ['GET', '/connectors/owned-fixture/status', 401],
  ['GET', '/connectors/catalog', 401],
  ['GET', '/connectors/image/capabilities', 401],
  ['GET', '/health', 200],
  ['GET', '/health/connectors', 200],
  ['GET', '/health/metrics', 200],
  ['GET', '/health/ready', 200],
  ['GET', '/jobs/owned-fixture', 401],
  ['GET', '/v1/models', 401],
  ['GET', '/v1/speech/stt/jobs/owned-fixture', 401],
  ['PATCH', '/admin/keys/owned-fixture/policy', 403],
  ['POST', '/admin/circuit-breaker/reset', 403],
  ['POST', '/admin/credits/owned-fixture', 403],
  ['POST', '/admin/credits/owned-fixture/gift', 403],
  ['POST', '/admin/credits/holds/sweep', 403],
  ['POST', '/admin/credits/reconcile', 403],
  ['POST', '/admin/keys', 403],
  ['POST', '/connectors/owned-fixture/execute', 401],
  ['POST', '/execute', 401],
  ['POST', '/images/generate', 401],
  ['POST', '/internal/credits/owned-fixture/payment', 403],
  ['POST', '/internal/credits/owned-fixture/reverse', 403],
  ['POST', '/internal/watcher/circuit-breaker/reset', 403],
  ['POST', '/v1/chat/completions', 401],
  ['POST', '/v1/prompt-cache/prewarm', 401],
  ['POST', '/v1/speech/stt', 401],
  ['POST', '/v1/speech/stt/async', 401],
  ['POST', '/v1/speech/tts', 401],
  ['POST', '/v1/speech/vad', 401],
];

async function start(omitHealth = false) {
  const empty = Object.freeze({});
  const moduleRef = await Test.createTestingModule({
    controllers: controllers.filter((c) => !omitHealth || c !== HealthController),
    providers: [
      AuthGuard,
      { provide: AuthService, useValue: empty },
      { provide: AdminService, useValue: empty },
      { provide: BillingService, useValue: empty },
      { provide: BillingReconcilerService, useValue: empty },
      { provide: ConnectorsService, useValue: { listNames: () => [] } },
      { provide: ImageGenerationService, useValue: empty },
      { provide: CascadeRouterService, useValue: empty },
      { provide: FailoverRouterService, useValue: empty },
      { provide: MetricsService, useValue: { getAll: () => ({}) } },
      {
        provide: PrismaService,
        useValue: {
          $queryRaw: () => {
            throw new Error('owned fixture: no database');
          },
        },
      },
      { provide: SpeechService, useValue: empty },
      { provide: SpeechMetricsService, useValue: empty },
      { provide: SttRouterService, useValue: empty },
      { provide: SttQuotaService, useValue: empty },
      { provide: getQueueToken('connector-jobs-stt'), useValue: empty },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
    { logger: false },
  );
  app.useGlobalGuards(moduleRef.get(AuthGuard));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  return { app, port: address.port };
}

async function probe(port: number, method: string, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 65536) req.destroy(new Error('fixture response oversized'));
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('fixture HTTP timeout')));
    req.on('error', reject);
    req.end();
  });
}

describe('owned actual controller/guard HTTP refusal boundary', () => {
  let fixture: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    fixture = await start();
  });
  afterAll(async () => {
    await fixture?.app.close();
  });

  // Explicit opt-in to the existing canonical producer, never a local imitation.
  // Inputs belong to this disposable fixture only; no application startup uses them.
  if (process.env.BENCH_SOURCE_HTTP_CANARY_DIR) {
    it('existing canonical producer observes this exact owned physical HTTP contour', async () => {
      const directory = process.env.BENCH_SOURCE_HTTP_CANARY_DIR!;
      const producer = process.env.BENCH_SOURCE_HTTP_PRODUCER!;
      const python = process.env.BENCH_SOURCE_HTTP_PYTHON!;
      const expectedDigest = process.env.BENCH_SOURCE_HTTP_PRODUCER_SHA256!;
      for (const path of [directory, producer, python]) {
        expect(typeof path).toBe('string');
        expect(isAbsolute(path)).toBe(true);
      }
      expect(createHash('sha256').update(readFileSync(producer)).digest('hex')).toBe(
        expectedDigest,
      );
      const plan = JSON.parse(readFileSync(join(directory, 'PLAN.json'), 'utf8'));
      expect(plan.schema).toBe('CanaryPlan/v1');
      expect(plan.api_key_env).toBeUndefined();
      expect(plan.probes).toHaveLength(boundaryCases.length);
      expect(
        plan.probes.map((p: { method: string; path: string; expect: { status_in: number[] } }) => [
          p.method,
          p.path,
          p.expect.status_in[0],
        ]),
      ).toEqual(boundaryCases);
      await promisify(execFile)(
        python,
        [
          '-B',
          producer,
          'canary',
          '--plan',
          'PLAN.json',
          '--subject-repo',
          process.cwd(),
          '--phase',
          'pre',
          '--base-url',
          `http://127.0.0.1:${fixture.port}`,
          '--timeout',
          '1',
          '--out',
          'RESULT.json',
        ],
        { cwd: directory, timeout: 45000, maxBuffer: 1048576 },
      );
      const result = JSON.parse(readFileSync(join(directory, 'RESULT.json'), 'utf8'));
      expect(result.schema).toBe('CanaryResult/v1');
      expect(result.source_binding_errors ?? []).toEqual([]);
      expect(result.counters).toEqual({
        verified: boundaryCases.length,
        failed: 0,
        not_measured: 0,
      });
      expect(
        result.probes.map((p: { method: string; status: number }) => [p.method, p.status]),
      ).toEqual(boundaryCases.map(([method, , status]) => [method, status]));
    }, 60000);
  }

  for (const [method, path, status] of boundaryCases) {
    it(`physical ${method} ${path} returns ${status} with no caller/provider`, async () => {
      const result = await probe(fixture.port, method, path);
      expect(result.status).toBe(status);
      if (status === 401) expect(JSON.parse(result.body).message).toBe('Missing Bearer token');
      if (status === 403) expect(JSON.parse(result.body).error).toBe('Forbidden');
      if (path === '/health/ready') expect(JSON.parse(result.body).checks.database).toBe('error');
      if (path === '/health') expect(JSON.parse(result.body).status).toBe('ok');
    });
  }

  it('missing physical route returns 404 instead of a guard success', async () => {
    expect((await probe(fixture.port, 'GET', '/owned-no-such-route')).status).toBe(404);
  });

  it('real controller removal makes the public-health positive refuse', async () => {
    const mutant = await start(true);
    try {
      const result = await probe(mutant.port, 'GET', '/health');
      expect(result.status).toBe(404);
      expect(result.status).not.toBe(200);
    } finally {
      await mutant.app.close();
    }
  });

  // Positive handler dispatch is separate from HTTP unauthenticated refusal.
  // These doubles are explicit source-unit data, never a financial receipt.
  const paymentBody = {
    amountUsd: '1.25',
    idempotencyKey: 'owned-source-payment-fixture',
    source: 'owned-source-fixture',
    livemode: false,
  };
  function paymentHandler() {
    const billing = {
      recordPayment: vi.fn().mockResolvedValue(false),
      balance: vi.fn().mockResolvedValue('0'),
    };
    return {
      controller: new PaymentsController(billing as unknown as BillingService),
      billing,
    };
  }

  it('actual payment handler preserves explicit fixture actor and decimal wire fields', async () => {
    const { controller, billing } = paymentHandler();
    const result = await controller.payment('owned-fixture', paymentBody, {
      [PAYMENTS_PRINCIPAL]: 'owned-source-principal',
    });
    expect(billing.recordPayment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        apiKeyId: 'owned-fixture',
        ...paymentBody,
        actor: 'owned-source-principal',
      }),
    );
    expect(result).toEqual({
      apiKeyId: 'owned-fixture',
      applied: false,
      entryType: 'payment',
      balanceUsd: '0',
    });
  });

  it('actual payment handler refuses absent principal before the inert billing double', async () => {
    const { controller, billing } = paymentHandler();
    await expect(controller.payment('owned-fixture', paymentBody, {})).rejects.toThrow(
      'no authenticated payments principal',
    );
    expect(billing.recordPayment).not.toHaveBeenCalled();
  });

  for (const amountUsd of ['Infinity', 0, '1000000000']) {
    it(`actual payment handler refuses invalid amount ${amountUsd} before billing`, async () => {
      const { controller, billing } = paymentHandler();
      await expect(
        controller.payment(
          'owned-fixture',
          { ...paymentBody, amountUsd },
          {
            [PAYMENTS_PRINCIPAL]: 'owned-source-principal',
          },
        ),
      ).rejects.toThrow();
      expect(billing.recordPayment).not.toHaveBeenCalled();
    });
  }
});

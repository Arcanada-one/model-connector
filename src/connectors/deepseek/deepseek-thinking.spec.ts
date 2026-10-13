import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MetricsService } from '../../metrics/metrics.service';
import { ConnectorsService } from '../connectors.service';
import { executeRequestSchema, perConnectorExecuteSchema } from '../dto/execute.dto';
import { OutputGuardMiddleware } from '../output-guard/output-guard.middleware';
import { DeepSeekConnector } from './deepseek.connector';

describe('DeepSeek thinking execute boundary (offline)', () => {
  let connector: DeepSeekConnector;
  let service: ConnectorsService;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'offline-test-sentinel');
    vi.stubEnv('PROVIDER_ACCESS', '');
    connector = new DeepSeekConnector();
    const prisma = {
      request: { create: vi.fn().mockResolvedValue({ id: 'offline-request' }) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    service = new ConnectorsService(
      { add: vi.fn() } as unknown as Queue,
      prisma as unknown as PrismaService,
      { record: vi.fn() } as unknown as MetricsService,
      new OutputGuardMiddleware({ enabled: false, maxRetries: 0, timeoutMs: 5000 }),
    );
    service.register(connector);
    fetchSpy = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            model: 'deepseek-flash',
            choices: [{ message: { content: 'offline-result' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    for (const mode of [undefined, 'enabled', 'disabled'] as const) {
      for (const temperature of [0, 1]) {
        it(`preserves ${model}/${mode ?? 'omitted'}/temperature=${temperature} through DTO/service/fetch`, async () => {
          const dto = executeRequestSchema.parse({
            connector: 'deepseek',
            model,
            prompt: 'offline-prompt',
            extra: {
              temperature,
              ...(mode === undefined ? {} : { thinking: { type: mode } }),
              unrecognized: 'must-not-forward',
            },
          });
          const response = await service.execute(
            'deepseek',
            { ...dto, maxRetries: 0 },
            'offline-key',
          );
          expect(response.status).toBe('success');
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
          expect(body).toEqual({
            model,
            messages: [{ role: 'user', content: 'offline-prompt' }],
            stream: false,
            temperature,
            ...(mode === undefined ? {} : { thinking: { type: mode } }),
          });
          expect(body).not.toHaveProperty('reasoning_effort');
        });
      }
    }
  }

  const invalid = [
    { thinking: { type: 'unknown' } },
    { thinking: { type: 'disabled', unexpected: true } },
    { thinking: { type: 'disabled' }, reasoning_effort: 'high' },
    { thinking: null },
  ];
  it.each(invalid)('refuses invalid mode or effort before fetch: %j', async (extra) => {
    expect(
      executeRequestSchema.safeParse({ connector: 'deepseek', prompt: 'offline', extra }).success,
    ).toBe(false);
    // The per-connector route has no connector field in its DTO. Its real
    // service/connector path must enforce the same options before transport.
    const request = perConnectorExecuteSchema.parse({ prompt: 'offline', extra });
    const response = await service.execute(
      'deepseek',
      { ...request, maxRetries: 0 },
      'offline-key',
    );
    expect(response.error).toMatchObject({
      type: 'validation_error',
      retryable: false,
      recommendation: 'abort',
    });
    expect(response.usage.costUsd).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['low', 'medium', 'high'] as const)(
    'explicitly maps MC effort %s to documented provider vocabulary',
    async (effort) => {
      const dto = executeRequestSchema.parse({
        connector: 'deepseek',
        prompt: 'offline',
        effort,
        extra: { thinking: { type: 'enabled' } },
      });
      await service.execute('deepseek', { ...dto, maxRetries: 0 }, 'offline-key');
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.reasoning_effort).toBe(effort === 'medium' ? 'high' : effort);
    },
  );

  it('refuses contradictory shared/native effort and disabled/shared effort', async () => {
    for (const extra of [
      { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
      { thinking: { type: 'disabled' } },
    ]) {
      const response = await connector.execute({ prompt: 'offline', effort: 'low', extra });
      expect(response.error?.type).toBe('validation_error');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not alter another connector-specific thinking vocabulary', () => {
    expect(
      executeRequestSchema.safeParse({
        connector: 'claude-code',
        prompt: 'offline',
        extra: { thinking: 'enabled' },
      }).success,
    ).toBe(true);
  });
});

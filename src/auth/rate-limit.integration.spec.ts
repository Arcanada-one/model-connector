/**
 * A2-301 — the per-key rate limit against a REAL Redis and a REAL Postgres.
 *
 * `rate-limit.app.spec.ts` proves the rules with the two process boundaries
 * doubled, which leaves exactly one class of bug uncovered: a double that
 * answers in a shape real Redis does not use. `INCR` replies with an integer and
 * `GET` with a bulk string, and a limiter that compared the wrong one would pass
 * every unit test and count nothing in production. So this file talks to the
 * real thing — real ioredis pipeline replies, a real `ApiKey` row read by real
 * Prisma, real bcrypt in `AuthService`, over a real Fastify HTTP stack.
 *
 * Excluded from `pnpm test` by vitest.config.ts (it needs infrastructure) and run
 * by `pnpm test:integration`. It requires:
 *   DATABASE_URL  -> a scratch database, never a shared one; it INSERTs and
 *                    UPDATEs `ApiKey` rows and deletes its own at the end.
 *   REDIS_HOST/PORT
 *   REDIS_PREFIX  -> a namespace of this run's own. Every key it writes starts
 *                    with it and is deleted in the teardown.
 *
 * It contacts no provider and spends nothing: no route here reaches a connector.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Controller, Get, Module } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import Redis from 'ioredis';
import { hash } from 'bcryptjs';

import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { RateLimitGuard } from './rate-limit.guard';
import { AbortBudgetInterceptor } from './abort-budget.interceptor';
import { KeyRateLimitService, ABORT_BUDGET_THRESHOLD } from './key-rate-limit.service';
import { KEY_RATE_LIMIT_REDIS_CLIENT } from './key-rate-limit.token';
import { PrismaService } from '../prisma/prisma.service';
import { validateEnv } from '../config/env.schema';

const PREFIX = process.env.REDIS_PREFIX ?? 'a2301-it:';
const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

const BASE_ENV = {
  PORT: '3931',
  NODE_ENV: 'development',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST,
  REDIS_PORT: String(REDIS_PORT),
  REDIS_PREFIX: PREFIX,
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_TIMEOUT_MS: '300000',
  CONNECTOR_MAX_CONCURRENCY: '1',
  STT_GROQ_API_KEY: 'test-groq-key',
};

const KEY_A_ID = 'a2301aaa-1111-4111-8111-111111111111';
const KEY_B_ID = 'a2301bbb-2222-4222-8222-222222222222';
const RAW_A = 'a2301-live-token-a';
const RAW_B = 'a2301-live-token-b';

@Controller()
class LiveProbeController {
  @Get('probe/execute')
  execute() {
    return { ok: true };
  }

  /** Returns what base-api.connector returns for an aborted attempt. */
  @Get('probe/abort')
  abort() {
    return { status: 'timeout', error: { type: 'timeout', message: 'aborted' } };
  }
}

const prisma = new PrismaService();
let redis: Redis;
let app: NestFastifyApplication;
let rateLimit: KeyRateLimitService;

@Module({
  controllers: [LiveProbeController],
  providers: [
    AuthService,
    { provide: PrismaService, useValue: prisma },
    { provide: KEY_RATE_LIMIT_REDIS_CLIENT, useFactory: () => redis },
    KeyRateLimitService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: AbortBudgetInterceptor },
  ],
})
class LiveProbeModule {}

async function clearOwnKeys(): Promise<void> {
  // Only this run's namespace. A pattern without the prefix would be a
  // cross-tenant delete on a shared Redis.
  const keys = await redis.keys(`${PREFIX}rl:*`);
  if (keys.length) await redis.del(...keys);
}

beforeAll(async () => {
  validateEnv(BASE_ENV);
  redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
  await redis.ping();

  const rounds = 10;
  for (const [id, raw, name] of [
    [KEY_A_ID, RAW_A, 'a2301-live-a'],
    [KEY_B_ID, RAW_B, 'a2301-live-b'],
  ] as const) {
    await prisma.apiKey.upsert({
      where: { id },
      update: { rateLimit: 3, active: true },
      create: { id, name, keyHash: await hash(raw, rounds), rateLimit: 3, active: true },
    });
  }

  const moduleRef = await Test.createTestingModule({ imports: [LiveProbeModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  rateLimit = moduleRef.get(KeyRateLimitService);
});

afterAll(async () => {
  await clearOwnKeys();
  await prisma.apiKey.deleteMany({ where: { id: { in: [KEY_A_ID, KEY_B_ID] } } });
  await app?.close();
  await redis?.quit();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await clearOwnKeys();
  await prisma.apiKey.updateMany({
    where: { id: { in: [KEY_A_ID, KEY_B_ID] } },
    data: { rateLimit: 3 },
  });
  rateLimit.flushLimitCache();
  app.get(AuthService).flushVerifyCache();
});

function get(path: string, raw?: string) {
  return app.inject({
    method: 'GET',
    url: path,
    ...(raw ? { headers: { authorization: `Bearer ${raw}` } } : {}),
  });
}

describe('against real Redis and real Postgres', () => {
  it('a burst over the row value is refused with 429 and Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await get('probe/execute', RAW_A)).statusCode);

    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    const refused = await get('probe/execute', RAW_A);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(refused.json().error).toBe('rate_limited');
  });

  it('the counter really exists in Redis, under this run own prefix', async () => {
    await get('probe/execute', RAW_A);

    const keys = await redis.keys(`${PREFIX}rl:req:${KEY_A_ID}:*`);
    expect(keys).toHaveLength(1);

    // Read back through real Redis: GET returns a bulk string, which is the
    // shape the unit-test double had to imitate.
    const raw = await redis.get(keys[0]);
    expect(typeof raw).toBe('string');
    expect(Number(raw)).toBe(1);

    // And it has a TTL, so a quiet key cannot leak forever.
    expect(await redis.ttl(keys[0])).toBeGreaterThan(0);
  });

  it('a second real key is unaffected', async () => {
    for (let i = 0; i < 5; i++) await get('probe/execute', RAW_A);
    expect((await get('probe/execute', RAW_A)).statusCode).toBe(429);

    expect((await get('probe/execute', RAW_B)).statusCode).toBe(200);
  });

  it('UPDATE ApiKey.rateLimit changes what the HTTP surface allows', async () => {
    expect((await get('probe/execute', RAW_A)).statusCode).toBe(200);
    expect((await get('probe/execute', RAW_A)).statusCode).toBe(200);
    expect((await get('probe/execute', RAW_A)).statusCode).toBe(200);
    expect((await get('probe/execute', RAW_A)).statusCode).toBe(429);

    // A real UPDATE against a real column.
    await prisma.apiKey.update({ where: { id: KEY_A_ID }, data: { rateLimit: 8 } });
    rateLimit.flushLimitCache(); // stands in for the 10s TTL elapsing
    await clearOwnKeys(); // and for the window rolling over

    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await get('probe/execute', RAW_A)).statusCode);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 429]);
  });

  it('enough aborted attempts degrade the key, counted in real Redis', async () => {
    await prisma.apiKey.update({ where: { id: KEY_A_ID }, data: { rateLimit: 1000 } });
    rateLimit.flushLimitCache();

    for (let i = 0; i < ABORT_BUDGET_THRESHOLD; i++) {
      expect((await get('probe/abort', RAW_A)).statusCode).toBe(200);
    }

    const abortKeys = await redis.keys(`${PREFIX}rl:abort:${KEY_A_ID}:*`);
    expect(abortKeys).toHaveLength(1);
    expect(Number(await redis.get(abortKeys[0]))).toBe(ABORT_BUDGET_THRESHOLD);

    const refused = await get('probe/execute', RAW_A);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().message).toContain('Aborted-attempt budget exhausted');
  });
});

describe('Redis genuinely unreachable', () => {
  /**
   * The shared Redis is never stopped to test this — other sessions use it.
   * Instead a second app is built against a port nothing listens on, which is
   * what the service sees during an outage.
   */
  it('fails CLOSED with 503, not open and not 429', async () => {
    const deadRedis = new Redis({
      host: '127.0.0.1',
      port: 1, // reserved, nothing listens
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [LiveProbeController],
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: KEY_RATE_LIMIT_REDIS_CLIENT, useValue: deadRedis },
        KeyRateLimitService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
      ],
    }).compile();

    const deadApp = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    await deadApp.init();
    await deadApp.getHttpAdapter().getInstance().ready();

    try {
      const res = await deadApp.inject({
        method: 'GET',
        url: 'probe/execute',
        headers: { authorization: `Bearer ${RAW_A}` },
      });

      // Fail-closed: the request is refused rather than admitted unmetered.
      expect(res.statusCode).toBe(503);
      // And NOT 429 — the caller did not exceed anything, and their backoff
      // logic branches on the status.
      expect(res.statusCode).not.toBe(429);
      expect(res.json().error).toBe('service_unavailable');
    } finally {
      await deadApp.close();
      deadRedis.disconnect();
    }
  });
});

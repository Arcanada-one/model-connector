import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitExempt } from './rate-limit-exempt.decorator';
import { AbortBudgetInterceptor } from './abort-budget.interceptor';
import { KeyRateLimitService } from './key-rate-limit.service';
import { KEY_RATE_LIMIT_REDIS_CLIENT, IKeyRateLimitRedis } from './key-rate-limit.token';
import { Public } from './public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { validateEnv } from '../config/env.schema';

/**
 * A2-301 — the per-key rate limit, proven through a REAL Nest application.
 *
 * This file exists because the unit tests cannot fail for the reason most likely
 * to break this feature. `RateLimitGuard` reads `request.apiKey`, and the only
 * thing that puts it there is `AuthGuard`; if the two global guards ever run in
 * the other order the limiter silently stops limiting and every unit test stays
 * green. So the guards here are the REAL guards, registered as `APP_GUARD` in
 * the same order `auth.module.ts` registers them, resolved by the real
 * `Reflector` and driven over a real Fastify HTTP stack via `app.inject`.
 *
 * RED BEFORE GREEN: with the `RateLimitGuard` registration removed — i.e. the
 * state of `main` before this change — the burst test below returns 200 for
 * every request and fails. That run is recorded in the PR body.
 *
 * Only the two process boundaries are doubled: Postgres (one indexed row read)
 * and Redis (counters). Everything between them is production code.
 */

const BASE_ENV = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PREFIX: 'conn-apptest:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_MAX_CONCURRENCY: '4',
  STT_GROQ_API_KEY: 'test-groq-key',
};

/** ioredis-shaped in-memory double (INCR -> number, GET -> string | null). */
class FakeRedis implements IKeyRateLimitRedis {
  readonly store = new Map<string, number>();
  multi() {
    const ops: Array<() => [Error | null, unknown]> = [];
    const self = this;
    const p = {
      incr(key: string) {
        ops.push(() => {
          const n = (self.store.get(key) ?? 0) + 1;
          self.store.set(key, n);
          return [null, n] as [Error | null, unknown];
        });
        return p;
      },
      expire() {
        ops.push(() => [null, 1] as [Error | null, unknown]);
        return p;
      },
      get(key: string) {
        ops.push(() => {
          const v = self.store.get(key);
          return [null, v === undefined ? null : String(v)] as [Error | null, unknown];
        });
        return p;
      },
      async exec() {
        return ops.map((op) => op());
      },
    };
    return p;
  }
  async incr(key: string) {
    const n = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, n);
    return n;
  }
  async expire() {
    return 1;
  }
}

/**
 * The two API keys under test. `AuthService` is doubled (it bcrypt-compares
 * against Postgres), but the REAL `AuthGuard` is what reads its answer and
 * writes `request.apiKey` — the contract this feature depends on.
 */
const KEYS: Record<string, { id: string; name: string }> = {
  'token-a': { id: 'key-a', name: 'client-a' },
  'token-b': { id: 'key-b', name: 'client-b' },
};

/** Mutable "database" so a test can change a limit and watch behaviour change. */
const limits: Record<string, number> = { 'key-a': 2, 'key-b': 2 };

@Controller()
class ProbeController {
  /** Stands in for a paid path: authenticated, not exempt. */
  @Get('probe/execute')
  execute() {
    return { ok: true };
  }

  /** Stands in for `/metrics`: authenticated, exempt with a reason. */
  @Get('probe/metrics')
  @RateLimitExempt('test: stands in for the Prometheus scrape exemption')
  metrics() {
    return { ok: true };
  }

  /** Stands in for `/health`: no API key at all. */
  @Get('probe/health')
  @Public()
  health() {
    return { ok: true };
  }

  /** Returns an aborted-attempt outcome, exactly as base-api.connector does. */
  @Get('probe/abort')
  abort() {
    return { status: 'timeout', error: { type: 'timeout', message: 'aborted' } };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [
    { provide: AuthService, useValue: { validateKey: async (t: string) => KEYS[t] ?? null } },
    {
      provide: PrismaService,
      useValue: {
        apiKey: {
          findUnique: async ({ where }: { where: { id: string } }) =>
            limits[where.id] === undefined ? null : { rateLimit: limits[where.id] },
        },
      },
    },
    { provide: KEY_RATE_LIMIT_REDIS_CLIENT, useClass: FakeRedis },
    KeyRateLimitService,
    // Registration order mirrors auth.module.ts. If it were reversed, the burst
    // test below would go green-but-meaningless; that is the point of the file.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: AbortBudgetInterceptor },
  ],
})
class ProbeModule {}

let app: INestApplication;
let redis: FakeRedis;
let rateLimit: KeyRateLimitService;

const OLD_ENV = { ...process.env };

beforeAll(async () => {
  validateEnv(BASE_ENV);
  const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  redis = moduleRef.get(KEY_RATE_LIMIT_REDIS_CLIENT);
  rateLimit = moduleRef.get(KeyRateLimitService);
});

afterAll(async () => {
  await app?.close();
  process.env = { ...OLD_ENV };
});

beforeEach(() => {
  process.env = { ...OLD_ENV };
  validateEnv(BASE_ENV);
  redis.store.clear();
  rateLimit.flushLimitCache();
  limits['key-a'] = 2;
  limits['key-b'] = 2;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

function get(path: string, token?: string) {
  return app.inject({
    method: 'GET',
    url: path,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
}

describe('a burst over the limit is refused', () => {
  it('returns 429 once the per-key limit is passed (200 on main)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await get('probe/execute', 'token-a')).statusCode);

    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it('the 429 carries Retry-After and the standard error envelope', async () => {
    await get('probe/execute', 'token-a');
    await get('probe/execute', 'token-a');
    const refused = await get('probe/execute', 'token-a');

    expect(refused.statusCode).toBe(429);
    // RFC 9110: seconds on the wire, and never 0 (A2-207).
    const header = Number(refused.headers['retry-after']);
    expect(header).toBeGreaterThanOrEqual(1);
    expect(header).toBeLessThanOrEqual(60);

    const body = refused.json();
    expect(body.error).toBe('rate_limited');
    expect(body.message).toContain('limit 2');
    // Both units, as `retryAfterFields` defines them for this service.
    expect(body.retryAfterSeconds).toBe(header);
    expect(body.retryAfter).toBe(header * 1000);
  });

  it('never puts key material in the refusal', async () => {
    await get('probe/execute', 'token-a');
    await get('probe/execute', 'token-a');
    const refused = await get('probe/execute', 'token-a');

    const serialized = JSON.stringify(refused.json());
    expect(serialized).not.toContain('token-a');
    expect(serialized).not.toContain('Bearer');
  });
});

describe('the budget belongs to one key', () => {
  it('a second key is unaffected by the first key exhausting its budget', async () => {
    for (let i = 0; i < 4; i++) await get('probe/execute', 'token-a');
    expect((await get('probe/execute', 'token-a')).statusCode).toBe(429);

    // Same route, same window, different key.
    expect((await get('probe/execute', 'token-b')).statusCode).toBe(200);
    expect((await get('probe/execute', 'token-b')).statusCode).toBe(200);
    expect((await get('probe/execute', 'token-b')).statusCode).toBe(429);
  });
});

describe('the limit follows the database value', () => {
  it('raising the row raises what the HTTP surface allows', async () => {
    expect((await get('probe/execute', 'token-a')).statusCode).toBe(200);
    expect((await get('probe/execute', 'token-a')).statusCode).toBe(200);
    expect((await get('probe/execute', 'token-a')).statusCode).toBe(429);

    limits['key-a'] = 5;
    rateLimit.flushLimitCache(); // stands in for the 10s TTL elapsing
    redis.store.clear(); // and for the window rolling over

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await get('probe/execute', 'token-a')).statusCode);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('lowering the row lowers it too — the DB is the authority, not a constant', async () => {
    limits['key-a'] = 1;
    rateLimit.flushLimitCache();

    expect((await get('probe/execute', 'token-a')).statusCode).toBe(200);
    expect((await get('probe/execute', 'token-a')).statusCode).toBe(429);
  });
});

describe('what is exempt, and what is merely unauthenticated', () => {
  it('an @RateLimitExempt route is not counted at all', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await get('probe/metrics', 'token-a')).statusCode).toBe(200);
    }
    // Not merely allowed — not even counted, so a scrape cannot spend the
    // budget that a paid path needs.
    expect((await get('probe/execute', 'token-a')).statusCode).toBe(200);
  });

  it('a @Public route carries no key, so there is no per-key budget to apply', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await get('probe/health')).statusCode).toBe(200);
    }
  });

  it('an invalid key is still rejected by AuthGuard, not by the limiter', async () => {
    const res = await get('probe/execute', 'nonsense');
    expect(res.statusCode).toBe(401);
    // Nothing was counted for a key that does not exist.
    expect([...redis.store.keys()]).toHaveLength(0);
  });
});

describe('the abort budget degrades a key to 429', () => {
  it('enough aborted attempts refuse the next request, with the abort reason', async () => {
    limits['key-a'] = 1000;
    rateLimit.flushLimitCache();

    // Ten real round trips through the interceptor, each returning the
    // aborted-attempt shape the connector produces.
    for (let i = 0; i < 10; i++) {
      const res = await get('probe/abort', 'token-a');
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('timeout');
    }

    const refused = await get('probe/execute', 'token-a');
    expect(refused.statusCode).toBe(429);
    expect(refused.json().message).toContain('Aborted-attempt budget exhausted');
    // The abort window is the longer one, so the advertised wait exceeds a minute.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(60);
  });

  it('a successful call is not counted as an abort', async () => {
    limits['key-a'] = 1000;
    rateLimit.flushLimitCache();

    for (let i = 0; i < 20; i++) {
      expect((await get('probe/execute', 'token-a')).statusCode).toBe(200);
    }
    // Twenty successes, no degradation: the interceptor keys on the outcome,
    // not on traffic volume.
    expect((await get('probe/execute', 'token-a')).statusCode).toBe(200);
  });
});

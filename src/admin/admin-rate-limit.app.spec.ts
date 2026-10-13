import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';

import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { KeyRateLimitService } from '../auth/key-rate-limit.service';
import { KEY_RATE_LIMIT_REDIS_CLIENT, IKeyRateLimitRedis } from '../auth/key-rate-limit.token';
import { PrismaService } from '../prisma/prisma.service';
import { validateEnv } from '../config/env.schema';

/**
 * A2-319 — the rate limit of an EXISTING key is changed through the admin API,
 * and the HTTP surface follows it on the very next request.
 *
 * Before this change the only way to move a live key's limit was to edit the
 * production database by hand (control did exactly that for `arcana-kb-agent`,
 * 10 -> 60, before A2-301 shipped). Everything between the two process
 * boundaries is production code: the real `AdminController` behind the real
 * `AdminGuard`, the real `AdminService` calling the real `KeyRateLimitService`,
 * and the real `AuthGuard` + `RateLimitGuard` in `auth.module.ts` order.
 * Postgres (one row) and Redis (counters) are doubled.
 *
 * RED BEFORE GREEN is recorded in the PR: with `invalidateLimit` a no-op the
 * "next request" test fails (the old limit is served from the 10s cache), and
 * with the `RateLimitGuard` registration removed every 429 test fails.
 */

const BASE_ENV = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PREFIX: 'conn-admintest:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_MAX_CONCURRENCY: '4',
  STT_GROQ_API_KEY: 'test-groq-key',
};

const ADMIN_TOKEN = 'a'.repeat(64);

class FakeRedis implements IKeyRateLimitRedis {
  readonly store = new Map<string, number>();
  multi() {
    const ops: Array<() => [Error | null, unknown]> = [];
    const p = {
      incr: (key: string) => {
        ops.push(() => {
          const n = (this.store.get(key) ?? 0) + 1;
          this.store.set(key, n);
          return [null, n];
        });
        return p;
      },
      expire: () => {
        ops.push(() => [null, 1]);
        return p;
      },
      get: (key: string) => {
        ops.push(() => {
          const v = this.store.get(key);
          return [null, v === undefined ? null : String(v)];
        });
        return p;
      },
      exec: async () => ops.map((op) => op()),
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

interface Row {
  id: string;
  name: string;
  rateLimit: number;
  active: boolean;
  createdAt: Date;
  keyHash: string;
}

/** The "database": one row per key, including a hash that must never leave it. */
const rows = new Map<string, Row>();

function project(row: Row, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k as keyof Row]]));
}

const fakePrisma = {
  apiKey: {
    findUnique: async ({
      where,
      select,
    }: {
      where: { id: string };
      select?: Record<string, boolean>;
    }) => {
      const row = rows.get(where.id);
      return row ? project(row, select) : null;
    },
    update: async ({
      where,
      data,
      select,
    }: {
      where: { id: string };
      data: Partial<Row>;
      select?: Record<string, boolean>;
    }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error('P2025: record not found');
      Object.assign(row, data);
      return project(row, select);
    },
  },
};

/** Tokens -> key ids. AuthService bcrypt-compares against Postgres; doubled. */
const TOKENS: Record<string, string> = { 'token-a': 'key-a', 'token-b': 'key-b' };

@Controller()
class KeyedRouteController {
  /** Stands in for any API-key-authenticated, non-exempt route. */
  @Get('keyed')
  keyed() {
    return { ok: true };
  }
}

@Module({
  controllers: [AdminController, KeyedRouteController],
  providers: [
    AdminService,
    {
      provide: AuthService,
      useValue: {
        validateKey: async (t: string) => {
          const id = TOKENS[t];
          const row = id ? rows.get(id) : undefined;
          return row && row.active ? { id: row.id, name: row.name } : null;
        },
        flushVerifyCache: () => undefined,
      },
    },
    { provide: PrismaService, useValue: fakePrisma },
    { provide: KEY_RATE_LIMIT_REDIS_CLIENT, useClass: FakeRedis },
    KeyRateLimitService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
class AdminRateLimitModule {}

let app: NestFastifyApplication;
let redis: FakeRedis;
let rateLimit: KeyRateLimitService;
const OLD_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...OLD_ENV, ADMIN_TOKEN };
  validateEnv(BASE_ENV);
}

beforeAll(async () => {
  resetEnv();
  const moduleRef = await Test.createTestingModule({ imports: [AdminRateLimitModule] }).compile();
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
  resetEnv();
  redis.store.clear();
  rateLimit.flushLimitCache();
  rows.clear();
  for (const [id, name] of [
    ['key-a', 'client-a'],
    ['key-b', 'client-b'],
  ]) {
    rows.set(id, {
      id,
      name,
      rateLimit: 60,
      active: true,
      createdAt: new Date('2026-09-25T00:00:00Z'),
      keyHash: '$2a$10$this-hash-must-never-be-returned-or-logged',
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...OLD_ENV };
});

const keyed = (token: string) =>
  app.inject({ method: 'GET', url: '/keyed', headers: { authorization: `Bearer ${token}` } });

const patchLimit = (id: string, body: unknown, token: string | null = ADMIN_TOKEN) =>
  app.inject({
    method: 'PATCH',
    url: `/admin/keys/${id}/rate-limit`,
    headers: token ? { 'x-admin-token': token } : {},
    payload: body as Record<string, unknown>,
  });

describe('GET /admin/keys/:id', () => {
  it('reads the limit of one key, and nothing secret', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/keys/key-a',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ id: 'key-a', name: 'client-a', rateLimit: 60, active: true });
    expect(JSON.stringify(body)).not.toContain('hash');
  });

  it('is 403 without the admin token and 404 for an unknown id', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/keys/key-a' })).statusCode).toBe(403);
    const missing = await app.inject({
      method: 'GET',
      url: '/admin/keys/nope',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('PATCH /admin/keys/:id/rate-limit', () => {
  it('lowering a live key to 2 takes effect on the next request: 429 with Retry-After', async () => {
    // Warm the 10s limit cache with the OLD value first: without the
    // invalidation on write, the next requests would still see 60.
    expect((await keyed('token-a')).statusCode).toBe(200);

    const res = await patchLimit('key-a', { rateLimit: 2, actor: 'control@arcana-devs' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'key-a', rateLimit: 2, previousRateLimit: 60 });
    expect(rows.get('key-a')?.rateLimit).toBe(2);

    // One request already counted in this window; the second is the last allowed.
    const statuses = [(await keyed('token-a')).statusCode];
    const refused = await keyed('token-a');
    statuses.push(refused.statusCode);
    expect(statuses).toEqual([200, 429]);
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('a key within its limit keeps getting 200 while another key is throttled', async () => {
    await patchLimit('key-a', { rateLimit: 1, actor: 'probe' });
    expect((await keyed('token-a')).statusCode).toBe(200);
    expect((await keyed('token-a')).statusCode).toBe(429);
    for (let i = 0; i < 5; i++) expect((await keyed('token-b')).statusCode).toBe(200);
  });

  it('raising the limit lifts an in-force refusal immediately', async () => {
    await patchLimit('key-a', { rateLimit: 1, actor: 'probe' });
    await keyed('token-a');
    expect((await keyed('token-a')).statusCode).toBe(429);

    await patchLimit('key-a', { rateLimit: 60, actor: 'probe' });
    expect((await keyed('token-a')).statusCode).toBe(200);
  });

  it('writes one audit line naming key, old -> new and actor — never a key or hash', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await patchLimit('key-a', { rateLimit: 5, actor: 'control@mac', reason: 'A2-319 probe' });

    const lines = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('rateLimit changed'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('keyId=key-a');
    expect(lines[0]).toContain('60 -> 5');
    expect(lines[0]).toContain('actor=control@mac');
    expect(lines[0]).toContain('reason="A2-319 probe"');
    expect(lines[0]).not.toContain('$2a$');
    expect(lines[0]).not.toContain('token-a');
  });

  it('refuses without the admin token, with a wrong token, and leaves the row alone', async () => {
    expect((await patchLimit('key-a', { rateLimit: 1, actor: 'x' }, null)).statusCode).toBe(403);
    expect(
      (await patchLimit('key-a', { rateLimit: 1, actor: 'x' }, 'b'.repeat(64))).statusCode,
    ).toBe(403);
    // An API key is not an admin credential.
    const asKey = await app.inject({
      method: 'PATCH',
      url: '/admin/keys/key-a/rate-limit',
      headers: { authorization: 'Bearer token-a' },
      payload: { rateLimit: 1, actor: 'x' },
    });
    expect(asKey.statusCode).toBe(403);
    expect(rows.get('key-a')?.rateLimit).toBe(60);
  });

  it.each<[Record<string, unknown>, string]>([
    [{ rateLimit: 5 }, 'no actor'],
    [{ rateLimit: 0, actor: 'x' }, 'below 1'],
    [{ rateLimit: 10001, actor: 'x' }, 'above 10000'],
    [{ rateLimit: 2.5, actor: 'x' }, 'not an integer'],
    [{ rateLimit: 5, actor: 'evil\nactor=root' }, 'newline in actor'],
    [{ rateLimit: 5, actor: 'x', reason: 'two\nlines' }, 'newline in reason'],
  ])('400 for %j (%s), row unchanged', async (body) => {
    expect((await patchLimit('key-a', body)).statusCode).toBe(400);
    expect(rows.get('key-a')?.rateLimit).toBe(60);
  });

  it('404 for an unknown key', async () => {
    expect((await patchLimit('nope', { rateLimit: 5, actor: 'x' })).statusCode).toBe(404);
  });
});

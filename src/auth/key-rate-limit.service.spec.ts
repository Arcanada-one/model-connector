import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ABORT_BUDGET_THRESHOLD,
  ABORT_BUDGET_WINDOW_SECONDS,
  FALLBACK_RATE_LIMIT,
  KeyRateLimitService,
  LIMIT_CACHE_TTL_MS,
  RATE_LIMIT_WINDOW_SECONDS,
  secondsToWindowEnd,
  windowOrdinal,
} from './key-rate-limit.service';
import { IKeyRateLimitPipeline, IKeyRateLimitRedis } from './key-rate-limit.token';
import { PrismaService } from '../prisma/prisma.service';
import { validateEnv } from '../config/env.schema';

/**
 * A2-301 — `ApiKey.rateLimit` was a column nothing read. These are the unit
 * tests for the counting itself; `rate-limit.app.spec.ts` proves the same rules
 * through a real Nest app, which is where the guard-ordering risk lives.
 *
 * The Redis double below answers in the SHAPE ioredis answers, which is the one
 * detail a self-written fixture gets to be wrong about: `INCR` replies with a
 * NUMBER and `GET` replies with a STRING (or null). A fake that returned a
 * number for `GET` would let a `===`-style bug pass here and fail in production,
 * so the string is deliberate — and the live check against real Redis on the dev
 * instance (see the PR) is what makes this claim a measurement rather than an
 * assumption.
 */

const BASE_ENV = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PREFIX: 'conn-test:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_MAX_CONCURRENCY: '4',
  STT_GROQ_API_KEY: 'test-groq-key',
};

/** An in-memory stand-in that replies the way ioredis replies. */
class FakeRedis implements IKeyRateLimitRedis {
  readonly store = new Map<string, number>();
  readonly expires: Array<{ key: string; seconds: number }> = [];
  failWith: Error | null = null;
  /** Set to make `exec()` resolve null, as ioredis does on a lost connection. */
  execReturnsNull = false;

  multi(): IKeyRateLimitPipeline {
    const ops: Array<() => [Error | null, unknown]> = [];
    const self = this;
    const pipeline: IKeyRateLimitPipeline = {
      incr(key) {
        ops.push(() => {
          const next = (self.store.get(key) ?? 0) + 1;
          self.store.set(key, next);
          return [null, next]; // ioredis: INCR -> integer
        });
        return pipeline;
      },
      expire(key, seconds) {
        ops.push(() => {
          self.expires.push({ key, seconds });
          return [null, 1];
        });
        return pipeline;
      },
      get(key) {
        ops.push(() => {
          const v = self.store.get(key);
          // ioredis: GET -> bulk string, or null when the key is absent.
          return [null, v === undefined ? null : String(v)];
        });
        return pipeline;
      },
      async exec() {
        if (self.failWith) throw self.failWith;
        if (self.execReturnsNull) return null;
        return ops.map((op) => op());
      },
    };
    return pipeline;
  }

  async incr(key: string): Promise<number> {
    const next = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return next;
  }

  async expire(): Promise<unknown> {
    return 1;
  }
}

function makePrisma(rows: Record<string, { rateLimit: number } | null>) {
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null);
  return {
    prisma: { apiKey: { findUnique } } as unknown as PrismaService,
    findUnique,
  };
}

const OLD_ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...OLD_ENV };
  validateEnv(BASE_ENV);
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.useRealTimers();
});

describe('window arithmetic', () => {
  it('Retry-After never advertises 0 seconds', () => {
    // A2-207: `Retry-After: 0` is the one value that makes a correct client
    // hammer instead of wait. Exercise every second of a window, not a sample.
    for (let s = 0; s < RATE_LIMIT_WINDOW_SECONDS; s++) {
      const atSecond = s * 1000;
      const advertised = secondsToWindowEnd(atSecond, RATE_LIMIT_WINDOW_SECONDS);
      expect(advertised).toBeGreaterThanOrEqual(1);
      expect(advertised).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_SECONDS);
    }
  });

  it('the window ordinal changes exactly at the boundary', () => {
    const w = RATE_LIMIT_WINDOW_SECONDS;
    expect(windowOrdinal(59_999, w)).toBe(0);
    expect(windowOrdinal(60_000, w)).toBe(1);
    expect(windowOrdinal(119_999, w)).toBe(1);
  });
});

describe('the limit comes from the database', () => {
  it('reads ApiKey.rateLimit and enforces THAT number, not a constant', async () => {
    const redis = new FakeRedis();
    const { prisma } = makePrisma({ 'key-a': { rateLimit: 3 } });
    const svc = new KeyRateLimitService(redis, prisma);

    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) outcomes.push((await svc.consume('key-a')).outcome);

    expect(outcomes).toEqual(['allowed', 'allowed', 'allowed', 'over_limit']);
  });

  it('a changed database row changes behaviour (bounded by the 10s cache)', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const rows: Record<string, { rateLimit: number } | null> = { 'key-a': { rateLimit: 1 } };
    const { prisma } = makePrisma(rows);
    const svc = new KeyRateLimitService(redis, prisma);

    expect((await svc.consume('key-a')).outcome).toBe('allowed');
    expect((await svc.consume('key-a')).outcome).toBe('over_limit');

    // Raise the limit in the "database". Still cached -> still refused.
    rows['key-a'] = { rateLimit: 10 };
    expect((await svc.consume('key-a')).outcome).toBe('over_limit');

    // Past the cache TTL the new value is in force. This is the documented
    // staleness bound, asserted rather than described.
    vi.advanceTimersByTime(LIMIT_CACHE_TTL_MS + 1);
    const after = await svc.consume('key-a');
    expect(after.outcome).toBe('allowed');
    expect(after.limit).toBe(10);
  });

  it('caches the row read so a flood cannot become a query per request', async () => {
    const redis = new FakeRedis();
    const { prisma, findUnique } = makePrisma({ 'key-a': { rateLimit: 100 } });
    const svc = new KeyRateLimitService(redis, prisma);

    for (let i = 0; i < 25; i++) await svc.consume('key-a');

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('falls back to the schema default when the row is gone, and says so', async () => {
    const redis = new FakeRedis();
    const { prisma } = makePrisma({});
    const svc = new KeyRateLimitService(redis, prisma);

    const decision = await svc.consume('vanished');

    expect(decision.limit).toBe(FALLBACK_RATE_LIMIT);
    expect(decision.outcome).toBe('allowed');
  });
});

describe('budgets are per key', () => {
  it('exhausting one key leaves another untouched', async () => {
    const redis = new FakeRedis();
    const { prisma } = makePrisma({
      'key-a': { rateLimit: 1 },
      'key-b': { rateLimit: 1 },
    });
    const svc = new KeyRateLimitService(redis, prisma);

    expect((await svc.consume('key-a')).outcome).toBe('allowed');
    expect((await svc.consume('key-a')).outcome).toBe('over_limit');

    // key-b has spent nothing. If the counters shared a key this would refuse.
    expect((await svc.consume('key-b')).outcome).toBe('allowed');
  });

  it('counter keys are namespaced by REDIS_PREFIX and by key id', async () => {
    const redis = new FakeRedis();
    const { prisma } = makePrisma({ 'key-a': { rateLimit: 5 } });
    const svc = new KeyRateLimitService(redis, prisma);

    await svc.consume('key-a');

    const keys = [...redis.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^conn-test:rl:req:key-a:\d+$/);
    // Every counter gets a TTL, so a key that stops calling cannot leak a key
    // into Redis forever.
    expect(redis.expires[0]?.seconds).toBe(RATE_LIMIT_WINDOW_SECONDS * 2);
  });
});

describe('Redis unavailable: fail CLOSED', () => {
  it('a thrown Redis error refuses the request instead of admitting it unmetered', async () => {
    const redis = new FakeRedis();
    redis.failWith = new Error('ECONNREFUSED');
    const { prisma } = makePrisma({ 'key-a': { rateLimit: 60 } });
    const svc = new KeyRateLimitService(redis, prisma);

    expect((await svc.consume('key-a')).outcome).toBe('backend_unavailable');
  });

  it('a null MULTI reply (connection lost mid-transaction) also fails closed', async () => {
    const redis = new FakeRedis();
    redis.execReturnsNull = true;
    const { prisma } = makePrisma({ 'key-a': { rateLimit: 60 } });
    const svc = new KeyRateLimitService(redis, prisma);

    expect((await svc.consume('key-a')).outcome).toBe('backend_unavailable');
  });

  it('a per-command error inside a successful MULTI is not read as a count', async () => {
    // ioredis reports per-command failures in the reply array, not by throwing.
    // Reading results[0][1] without checking results[0][0] would turn such a
    // reply into `count = 0`, i.e. "plenty of budget left".
    const { prisma } = makePrisma({ 'key-a': { rateLimit: 1 } });
    const redis = {
      multi: () => ({
        incr() {
          return this;
        },
        expire() {
          return this;
        },
        get() {
          return this;
        },
        async exec() {
          return [
            [new Error('READONLY You cant write against a read only replica.'), null],
            [null, 1],
            [null, null],
          ] as Array<[Error | null, unknown]>;
        },
      }),
      incr: async () => 1,
      expire: async () => 1,
    } as unknown as IKeyRateLimitRedis;

    const svc = new KeyRateLimitService(redis, prisma);
    expect((await svc.consume('key-a')).outcome).toBe('backend_unavailable');
  });
});

describe('abort budget (DEC-AUP-0050 R7 b)', () => {
  it('degrades a key to a refusal once the threshold is reached', async () => {
    const redis = new FakeRedis();
    const { prisma } = makePrisma({ 'key-a': { rateLimit: 1000 } });
    const svc = new KeyRateLimitService(redis, prisma);

    for (let i = 0; i < ABORT_BUDGET_THRESHOLD - 1; i++) await svc.recordAbort('key-a');
    expect((await svc.consume('key-a')).outcome).toBe('allowed');

    await svc.recordAbort('key-a');
    const refused = await svc.consume('key-a');
    expect(refused.outcome).toBe('abort_budget_exhausted');
    expect(refused.abortCount).toBe(ABORT_BUDGET_THRESHOLD);
    // The client is told to come back when the ABORT window rolls, which is the
    // longer of the two — not the request window.
    expect(refused.retryAfterSeconds).toBeGreaterThan(RATE_LIMIT_WINDOW_SECONDS);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(ABORT_BUDGET_WINDOW_SECONDS);
  });

  it("one key's aborts do not degrade another key", async () => {
    const redis = new FakeRedis();
    const { prisma } = makePrisma({
      'key-a': { rateLimit: 1000 },
      'key-b': { rateLimit: 1000 },
    });
    const svc = new KeyRateLimitService(redis, prisma);

    for (let i = 0; i < ABORT_BUDGET_THRESHOLD; i++) await svc.recordAbort('key-a');

    expect((await svc.consume('key-a')).outcome).toBe('abort_budget_exhausted');
    expect((await svc.consume('key-b')).outcome).toBe('allowed');
  });

  it('recording an abort never throws, even when Redis is down', async () => {
    const redis = new FakeRedis();
    redis.failWith = new Error('ECONNREFUSED');
    const { prisma } = makePrisma({ 'key-a': { rateLimit: 60 } });
    const svc = new KeyRateLimitService(redis, prisma);

    // A bookkeeping failure must not replace the caller's timeout envelope.
    await expect(svc.recordAbort('key-a')).resolves.toBeUndefined();
  });
});

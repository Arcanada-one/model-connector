import { describe, it, expect, beforeEach } from 'vitest';
import { SttQuotaService, type IRedisLike } from './stt-quota.service';
import { validateEnv } from '../../config/env.schema';

// CONN-0104 — SttQuotaService unit tests.
//
// Per memory `feedback_redis_lua_vs_multi`: ioredis-mock@8 is too thin for
// Lua/defineCommand. Our service uses ioredis `multi()` pipeline instead
// (race bound ~10ms, documented in plan § Security T5). The spec mocks the
// minimal Redis surface via vi.fn — narrower than full ioredis-mock and
// avoids a transitive dep that the package.json doesn't carry.
//
// Two methods covered:
//   * precheck(reqId)      — GET cost+req; allowed=false when cost >= cap
//   * commit(costMicroCents, reqId) — INCRBY cost+req + EXPIRE TTL_TO_MIDNIGHT
// Keys: conn:stt:quota:cost:YYYYMMDD + conn:stt:quota:req:YYYYMMDD.
// TTL: seconds until UTC midnight (≤86400).

function makeMockRedis(): IRedisLike & {
  _store: Map<string, number>;
  _ttls: Map<string, number>;
} {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  // multi() returns a chainable pipeline; exec() returns array of [err, val].
  const mockMulti = () => {
    const ops: Array<() => unknown> = [];
    const pipeline = {
      get(key: string) {
        ops.push(() => store.get(key) ?? null);
        return pipeline;
      },
      incrby(key: string, delta: number) {
        ops.push(() => {
          const next = (store.get(key) ?? 0) + delta;
          store.set(key, next);
          return next;
        });
        return pipeline;
      },
      expire(key: string, seconds: number) {
        ops.push(() => {
          ttls.set(key, seconds);
          return 1;
        });
        return pipeline;
      },
      async exec() {
        return ops.map((op) => [null, op()] as [Error | null, unknown]);
      },
    };
    return pipeline;
  };
  return {
    multi: mockMulti as unknown as IRedisLike['multi'],
    _store: store,
    _ttls: ttls,
  };
}

describe('SttQuotaService', () => {
  let redis: ReturnType<typeof makeMockRedis>;
  let svc: SttQuotaService;

  beforeEach(() => {
    validateEnv({
      DATABASE_URL: 'postgresql://test',
      STT_PROVIDER_GROQ_ENABLED: 'false',
      STT_DAILY_BUDGET_USD: '10',
    });
    redis = makeMockRedis();
    svc = new SttQuotaService(redis);
  });

  describe('precheck', () => {
    it('returns allowed=true when both counters are 0 (empty Redis)', async () => {
      const out = await svc.precheck('req-1');
      expect(out.allowed).toBe(true);
      expect(out.dailyCostMicroCents).toBe(0);
      expect(out.dailyReqCount).toBe(0);
    });

    it('returns allowed=false when dailyCost >= STT_DAILY_BUDGET_USD cap', async () => {
      // $10/day = 1_000_000_000 micro-cents (1 USD = 100 cents = 100_000_000 µc).
      const today = todayUtcKey();
      redis._store.set(`conn:stt:quota:cost:${today}`, 1_000_000_000);
      redis._store.set(`conn:stt:quota:req:${today}`, 42);

      const out = await svc.precheck('req-X');
      expect(out.allowed).toBe(false);
      expect(out.dailyCostMicroCents).toBe(1_000_000_000);
      expect(out.dailyReqCount).toBe(42);
    });

    it('returns allowed=true when dailyCost just below cap', async () => {
      const today = todayUtcKey();
      redis._store.set(`conn:stt:quota:cost:${today}`, 999_999_999);
      const out = await svc.precheck('req-2');
      expect(out.allowed).toBe(true);
    });
  });

  describe('commit', () => {
    it('INCRBYs cost + req counters atomically with TTL ≤ 86400', async () => {
      const today = todayUtcKey();
      await svc.commit(50_000, 'req-1'); // $0.0005 = 50_000 µc
      expect(redis._store.get(`conn:stt:quota:cost:${today}`)).toBe(50_000);
      expect(redis._store.get(`conn:stt:quota:req:${today}`)).toBe(1);
      const ttl = redis._ttls.get(`conn:stt:quota:cost:${today}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(86_400);
    });

    it('increments req counter even when costMicroCents=0 (self-hosted)', async () => {
      const today = todayUtcKey();
      await svc.commit(0, 'req-local-whisper-1');
      expect(redis._store.get(`conn:stt:quota:cost:${today}`)).toBe(0);
      expect(redis._store.get(`conn:stt:quota:req:${today}`)).toBe(1);
    });

    it('accumulates across multiple commits in same UTC day', async () => {
      const today = todayUtcKey();
      await svc.commit(10_000, 'r1');
      await svc.commit(20_000, 'r2');
      await svc.commit(30_000, 'r3');
      expect(redis._store.get(`conn:stt:quota:cost:${today}`)).toBe(60_000);
      expect(redis._store.get(`conn:stt:quota:req:${today}`)).toBe(3);
    });
  });

  describe('key format', () => {
    it('uses canonical conn:stt:quota:{cost|req}:YYYYMMDD UTC keys', async () => {
      await svc.commit(1, 'r');
      const keys = Array.from(redis._store.keys()).sort();
      expect(keys).toHaveLength(2);
      for (const k of keys) {
        expect(k).toMatch(/^conn:stt:quota:(cost|req):\d{8}$/);
      }
    });
  });

  describe('budget gate', () => {
    it('honours STT_DAILY_BUDGET_USD env override (e.g. $1 cap)', async () => {
      validateEnv({
        DATABASE_URL: 'postgresql://test',
        STT_PROVIDER_GROQ_ENABLED: 'false',
        STT_DAILY_BUDGET_USD: '1',
      });
      const tightSvc = new SttQuotaService(redis);
      const today = todayUtcKey();
      // $1 = 100_000_000 micro-cents.
      redis._store.set(`conn:stt:quota:cost:${today}`, 100_000_000);
      const out = await tightSvc.precheck('req-tight');
      expect(out.allowed).toBe(false);
    });
  });
});

function todayUtcKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

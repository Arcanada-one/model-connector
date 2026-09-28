import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import { validateEnv } from '../config/env.schema';
import { ConnectorsService } from './connectors.service';
import { CatalogRefreshService } from './catalog-refresh.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import type { PrismaService } from '../prisma/prisma.service';
import type { CatalogRepositoryLike } from './catalog.repository';

/**
 * A2-464 item 4 — two MC instances on one Redis (`conn:` and `conn-dev:`)
 * must neither share nor erase each other's catalog cache, and invalidation
 * must not use KEYS.
 *
 * Run twice: against an in-memory double that implements KEYS with Redis glob
 * semantics (so the pre-fix `KEYS conn:catalog:*` is observable), and — when
 * A2464_REDIS_PORT names a Redis of the runner's own — against real Redis
 * through the real client factory. CI has no Redis; there the real case is
 * skipped, and the PR carries the local run.
 */

const BASE_ENV = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: process.env.A2464_REDIS_PORT ?? '6379',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_MAX_CONCURRENCY: '4',
  STT_GROQ_API_KEY: 'test-groq-key',
};

/** The two instances' namespaces. Unique per run so a real Redis can be shared safely. */
const RUN = `a2464-${process.pid}-${Date.now()}`;
const PROD = `${RUN}-conn:`;
const DEV = `${RUN}-conn-dev:`;

function usePrefix(prefix: string): void {
  validateEnv({ ...BASE_ENV, REDIS_PREFIX: prefix });
}

/** Map-backed stand-in; records every command name so a KEYS call is visible. */
class GlobRedis {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly commands: string[] = [];
  async get(k: string) {
    this.commands.push('get');
    return this.strings.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.commands.push('set');
    this.strings.set(k, v);
    return 'OK';
  }
  async del(...ks: string[]) {
    this.commands.push('del');
    let n = 0;
    for (const k of ks) n += Number(this.strings.delete(k)) + Number(this.sets.delete(k));
    return n;
  }
  async keys(pattern: string) {
    this.commands.push('keys');
    const re = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    return [...this.strings.keys(), ...this.sets.keys()].filter((k) => re.test(k));
  }
  async sadd(k: string, m: string) {
    this.commands.push('sadd');
    const s = this.sets.get(k) ?? new Set<string>();
    s.add(m);
    this.sets.set(k, s);
    return 1;
  }
  async smembers(k: string) {
    this.commands.push('smembers');
    return [...(this.sets.get(k) ?? [])];
  }
  async pexpire() {
    this.commands.push('pexpire');
    return 1;
  }
  async ping() {
    return 'PONG';
  }
  async exists(k: string) {
    return this.strings.has(k) ? 1 : 0;
  }
}

type Client = GlobRedis | Redis;

function instance(client: Client) {
  const repo: CatalogRepositoryLike = { findAll: vi.fn().mockResolvedValue([]) };
  const svc = new ConnectorsService(
    { add: vi.fn() } as unknown as Queue,
    {} as unknown as PrismaService,
    {
      record: vi.fn(),
      getAll: vi.fn(),
    } as unknown as import('../metrics/metrics.service').MetricsService,
    new OutputGuardMiddleware({ enabled: true, maxRetries: 3, timeoutMs: 30_000 }),
    {
      getEntries: () => [],
      getFilteredEntries: () => [],
    } as unknown as import('./modality-catalog.service').ModalityCatalogService,
    repo,
    client as never,
  );
  const refresh = new CatalogRefreshService(svc, {} as never, client as never, {} as never);
  return {
    repo,
    fill: () => svc.getCatalog({ free: false, cheap: false, capability: undefined }),
    invalidate: () =>
      (refresh as unknown as { invalidateCatalogCache(): Promise<void> }).invalidateCatalogCache(),
  };
}

/** Every key under `<prefix>catalog:` except the index. */
async function cacheKeys(client: Client, prefix: string): Promise<string[]> {
  if (client instanceof GlobRedis) {
    return [...client.strings.keys()].filter((k) => k.startsWith(`${prefix}catalog:`)).sort();
  }
  // Test-side inspection only (never runtime): SCAN of this run's unique namespace.
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', `${prefix}catalog:*`, 'COUNT', 1000);
    cursor = next;
    found.push(...batch.filter((k) => !k.endsWith(':index')));
  } while (cursor !== '0');
  return found.sort();
}

function scenario(label: string, makeClient: () => Client, skip = false) {
  describe.skipIf(skip)(`A2-464 item 4 — two prefixes on one Redis (${label})`, () => {
    let client: Client;

    it('each instance writes under its own prefix', async () => {
      client = makeClient();
      usePrefix(PROD);
      const prod = instance(client);
      await prod.fill();
      usePrefix(DEV);
      const dev = instance(client);
      await dev.fill();

      const prodKeys = await cacheKeys(client, PROD);
      const devKeys = await cacheKeys(client, DEV);
      expect(prodKeys).toHaveLength(1);
      expect(devKeys).toHaveLength(1);
    });

    it('invalidating one prefix leaves the other intact, in both directions', async () => {
      usePrefix(PROD);
      await instance(client).invalidate();
      expect(await cacheKeys(client, PROD)).toEqual([]);
      expect(await cacheKeys(client, DEV)).toHaveLength(1);

      await instance(client).fill(); // repopulate PROD
      usePrefix(DEV);
      await instance(client).invalidate();
      expect(await cacheKeys(client, DEV)).toEqual([]);
      expect(await cacheKeys(client, PROD)).toHaveLength(1);
    });

    it('a cache hit after invalidation goes back to the DB (the entry really is gone)', async () => {
      usePrefix(PROD);
      await instance(client).invalidate();
      const fresh = instance(client);
      await fresh.fill();
      expect(fresh.repo.findAll).toHaveBeenCalledTimes(1);
      const cached = instance(client);
      await cached.fill();
      expect(cached.repo.findAll).not.toHaveBeenCalled();
    });

    if (label === 'in-memory') {
      it('runtime never sends KEYS', () => {
        expect((client as GlobRedis).commands).not.toContain('keys');
      });
      it('the index is given a TTL, so it cannot outlive the keys it lists', () => {
        expect((client as GlobRedis).commands).toContain('pexpire');
      });
    } else {
      it('the index is given a TTL, so it cannot outlive the keys it lists', async () => {
        const ttl = await (client as Redis).pttl(`${PROD}catalog:index`);
        expect(ttl).toBeGreaterThan(0);
      });
    }

    afterAll(async () => {
      if (client && !(client instanceof GlobRedis)) {
        for (const p of [PROD, DEV]) {
          usePrefix(p);
          await instance(client).invalidate();
        }
        client.disconnect();
      }
    });
  });
}

scenario('in-memory', () => new GlobRedis());
scenario(
  'real Redis',
  () => new Redis({ host: '127.0.0.1', port: Number(process.env.A2464_REDIS_PORT) }),
  !process.env.A2464_REDIS_PORT,
);

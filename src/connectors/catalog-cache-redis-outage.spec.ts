import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import type { FactoryProvider } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { validateEnv } from '../config/env.schema';
import { CATALOG_REDIS_PROVIDER } from './catalog-redis.provider';
import { ConnectorsService } from './connectors.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import type { PrismaService } from '../prisma/prisma.service';
import type { CatalogRepositoryLike } from './catalog.repository';

/**
 * A2-464 — the catalog cache is an accelerator in front of the DB, so losing
 * Redis must cost milliseconds, not the 41 s A2-462 measured live.
 *
 * These tests use the REAL ioredis client built by the REAL provider factory,
 * against sockets this test owns: a refused port, and a server that accepts
 * the connection and completes the ready-check but never answers a command
 * (a stopped or partitioned Redis). No fixture of ours stands in for ioredis
 * here — the thing under test is exactly ioredis's queue/retry behaviour.
 *
 * Before the fix both `get()` calls stay pending past the sentinel below (the
 * refused port until ioredis's default 20 reconnect retries run out, the stuck
 * server forever); that is the red this file was written to show.
 */

/**
 * How long a cache read may take to FAIL when Redis is gone: the 100 ms
 * CACHE_COMMAND_TIMEOUT_MS plus slack for a loaded CI runner. Tight on
 * purpose — a timeout raised to half a second must turn this red.
 */
const FAIL_FAST_BUDGET_MS = 400;
/** Past this, the call is reported as still pending — the pre-fix behaviour. */
const PENDING_SENTINEL_MS = 3_000;

const BASE_ENV = {
  PORT: '3900',
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PREFIX: 'a2464-test:',
  API_KEY_SALT_ROUNDS: '10',
  CONNECTOR_MAX_CONCURRENCY: '4',
  STT_GROQ_API_KEY: 'test-groq-key',
};

const clients: Redis[] = [];
const servers: net.Server[] = [];

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/**
 * Accepts connections and answers only what ioredis needs to reach `ready`
 * (INFO for the ready check); every other command is swallowed. This is a
 * Redis that is "up" at the TCP level and does not reply — the case a plain
 * reconnect policy never notices.
 */
async function stuckRedis(): Promise<number> {
  const info = 'loading:0\r\n';
  const srv = net.createServer((sock) => {
    sock.on('data', (buf) => {
      if (/INFO/i.test(buf.toString())) sock.write(`$${info.length}\r\n${info}\r\n`);
    });
    sock.on('error', () => undefined);
  });
  servers.push(srv);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return (srv.address() as net.AddressInfo).port;
}

function buildCatalogClient(port: number): Redis {
  validateEnv({ ...BASE_ENV, REDIS_PORT: String(port) });
  const client = (CATALOG_REDIS_PROVIDER as FactoryProvider).useFactory() as Redis;
  clients.push(client);
  return client;
}

/** Resolves with how the call settled and how long it took, or 'pending' at the sentinel. */
async function settle(p: Promise<unknown>): Promise<{ outcome: string; ms: number }> {
  const t0 = Date.now();
  const outcome = await Promise.race([
    p.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), PENDING_SENTINEL_MS)),
  ]);
  return { outcome, ms: Date.now() - t0 };
}

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.disconnect();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

describe('A2-464 item 1 — catalog cache fails fast when Redis is gone', () => {
  beforeAll(() => {
    // Keep the pre-fix red readable: ioredis prints to console.error when no one listens.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('refused port: get() rejects within the budget instead of queueing', async () => {
    const client = buildCatalogClient(await freePort());
    const r = await settle(client.get('k'));
    expect(r.outcome).toBe('rejected');
    expect(r.ms).toBeLessThan(FAIL_FAST_BUDGET_MS);
  }, 10_000);

  it('stuck Redis (connected, never replies): get() rejects within the budget', async () => {
    const client = buildCatalogClient(await stuckRedis());
    await waitFor(() => client.status === 'ready');
    const r = await settle(client.get('k'));
    expect(r.outcome).toBe('rejected');
    expect(r.ms).toBeLessThan(FAIL_FAST_BUDGET_MS);
  }, 10_000);

  it('GET /connectors/catalog path: getCatalog() answers from the DB within the budget', async () => {
    const client = buildCatalogClient(await freePort());
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
      client,
    );
    const r = await settle(svc.getCatalog({ free: false, cheap: false, capability: undefined }));
    expect(r.outcome).toBe('resolved');
    expect(r.ms).toBeLessThan(FAIL_FAST_BUDGET_MS);
    expect(repo.findAll).toHaveBeenCalledTimes(1);
  }, 10_000);
});

describe('A2-464 item 2 — a Redis connection error has somewhere to go, and says whose it is', () => {
  it('no "[ioredis] Unhandled error event"; the log line names the client and the operation', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const client = buildCatalogClient(await freePort());
    await waitFor(() => warn.mock.calls.length > 0 || consoleError.mock.calls.length > 0);
    const unhandled = consoleError.mock.calls.filter((c) =>
      String(c[0]).includes('Unhandled error event'),
    );
    expect(unhandled).toEqual([]);
    const line = String(warn.mock.calls[0]?.[0] ?? '');
    expect(line).toMatch(/client=catalog-cache/);
    expect(line).toMatch(/op=connect/);
    expect(line).toMatch(/ECONNREFUSED/);
    expect(client.listenerCount('error')).toBeGreaterThan(0);
  }, 10_000);
});

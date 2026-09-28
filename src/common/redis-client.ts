import { Logger } from '@nestjs/common';
import Redis, { type RedisOptions } from 'ioredis';

/**
 * A2-464 — one place that builds the plain (non-BullMQ) ioredis clients, so
 * every one of them has an `error` listener that says WHICH client failed and
 * in WHICH phase, and so a cache client can be told to fail fast.
 *
 * Without a listener ioredis prints `[ioredis] Unhandled error event` once per
 * reconnect attempt — A2-462 counted 102 such lines in one outage, none of
 * them naming the client.
 */

export interface RedisConnectionConfig {
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
}

/**
 * Fail-fast profile for a client whose data has another source of truth (the
 * catalog cache: the DB is the source, TTL 30 s).
 *
 * - `enableOfflineQueue: false` — while the socket is not `ready` a command is
 *   rejected at once instead of waiting in ioredis's queue. This is what turned
 *   a Redis outage into a 41 s catalog response (A2-462): the queued GET waited
 *   out the default 20 reconnect retries.
 * - `maxRetriesPerRequest: 0` — a command already written when the connection
 *   drops is rejected, not replayed after reconnect.
 * - `commandTimeout` — covers the case the two above cannot see: the socket is
 *   up but Redis does not answer (stopped process, partition without RST).
 *   The number is measured, not chosen; see CACHE_COMMAND_TIMEOUT_MS.
 */
export function cacheFailFastOptions(): Pick<
  RedisOptions,
  'enableOfflineQueue' | 'maxRetriesPerRequest' | 'commandTimeout'
> {
  return {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: CACHE_COMMAND_TIMEOUT_MS,
  };
}

/**
 * Upper bound for one catalog-cache command (A2-464, measured 2026-09-28 on
 * arcana-devs — receipts in the PR):
 *
 * - floor: a healthy loopback Redis serves a GET of a realistic catalog value
 *   (2 MB, ≈3000 entries) at p99.9 ≈ 8 ms and max ≈ 14 ms; small values are
 *   sub-millisecond. The bound must sit well above that so a busy-but-healthy
 *   Redis does not push reads onto the DB.
 * - ceiling: the fallback it protects, the DB read + mapping behind
 *   GET /connectors/catalog, took ≈ 20–40 ms end-to-end on the test stand.
 *   Waiting on the cache much longer than the DB read defeats its only purpose.
 *
 * 100 ms is ~7× the worst healthy read and ~3× the DB fallback: a failed cache
 * costs at most one tenth of a second, instead of 41 s.
 */
export const CACHE_COMMAND_TIMEOUT_MS = 100;

/**
 * Logs connection-level errors of one named client. Identical consecutive
 * errors are counted, not repeated; the count is reported when the client is
 * ready again, so nothing is hidden — the first failure and the recovery (with
 * how many retries failed in between) are both on the record.
 */
export function attachRedisErrorLogging(
  client: Redis,
  name: string,
  logger: Logger = new Logger('Redis'),
): Redis {
  let lastSignature: string | null = null;
  let repeats = 0;
  client.on('error', (err: Error & { code?: string }) => {
    // Errors emitted on the client (not on a command promise) are socket-level:
    // a failed (re)connect, or a live connection that broke.
    const op = client.status === 'ready' ? 'connection' : 'connect';
    const signature = `${op}:${err.code ?? err.message}`;
    if (signature === lastSignature) {
      repeats += 1;
      return;
    }
    lastSignature = signature;
    repeats = 0;
    logger.warn(
      `redis client=${name} op=${op} err=${err.code ?? err.name} status=${client.status}: ${err.message}`,
    );
  });
  client.on('ready', () => {
    if (lastSignature === null) return;
    logger.log(
      `redis client=${name} op=connect recovered after ${repeats + 1} failed attempt(s) (${lastSignature})`,
    );
    lastSignature = null;
    repeats = 0;
  });
  return client;
}

export function createRedisClient(
  name: string,
  cfg: RedisConnectionConfig,
  extra: RedisOptions = {},
): Redis {
  const client = new Redis({
    host: cfg.REDIS_HOST,
    port: cfg.REDIS_PORT,
    ...(cfg.REDIS_PASSWORD && { password: cfg.REDIS_PASSWORD }),
    lazyConnect: false,
    ...extra,
  });
  return attachRedisErrorLogging(client, name);
}

/** `err=<code or name>: <message>` for a failed Redis command — no stack, no values. */
export function describeRedisError(err: unknown): string {
  const e = err as { code?: string; name?: string; message?: string };
  return `err=${e?.code ?? e?.name ?? typeof err}: ${e?.message ?? String(err)}`;
}

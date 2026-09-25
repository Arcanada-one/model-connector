import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getConfig } from '../config/env.schema';
import { KEY_RATE_LIMIT_REDIS_CLIENT, IKeyRateLimitRedis } from './key-rate-limit.token';

/**
 * A2-301 — enforcement of `ApiKey.rateLimit`, which existed as a column and a
 * default since the schema was written and was read by NOTHING.
 *
 * Measured before this change (A2-299, re-measured here): the value never even
 * reached the request — `AuthService.validateKey` returns `{ id, name }`, so no
 * guard could have enforced it without a second read. `connector.arcanada.ai` is
 * public, and `/execute` dispatches to paid providers, so an unlimited key is an
 * unlimited bill. DEC-AUP-0050 R6 names an ENFORCED per-key limit as one of four
 * cumulative gates before an aborted attempt may ever be charged to a customer.
 *
 * ## The unit of `rateLimit` is a decision, not a reading
 * Nothing in the repository declares one: the column is bare `Int @default(60)`,
 * the admin DTO only bounds it to 1..10000, README and docs say nothing. Chosen
 * here: **requests per 60-second window**, because the measured peak on dev is
 * 43 requests/minute for a single key against that default of 60 — the only
 * reading under which the shipped default is neither already-exceeded nor
 * meaningless. Stated in the PR so a different unit is a deliberate change.
 *
 * ## Fixed window, and why it is honest to say so
 * The counter key embeds the window ordinal, so the TTL never has to be read
 * back and `Retry-After` is computed locally from the clock. The known cost of a
 * fixed window is a boundary burst: a caller timing two bursts around the seam
 * can land 2x`limit` inside one rolling minute. That is accepted, not hidden —
 * the control exists to bound SUSTAINED provider cost, which it does exactly,
 * and a true sliding window needs a per-key sorted set (unbounded memory) or a
 * Lua script. A follow-up may swap the algorithm; the interface would not move.
 *
 * ## Limit freshness: 10s, and why not the existing auth cache
 * `AuthService` caches verified keys for 5 minutes. Carrying the limit on that
 * cache would have been free — and wrong: when this was written there was no
 * admin endpoint to UPDATE `rateLimit`, so the only way to change a live key's
 * limit was to write the row, and a 5-minute blind spot on a control you reach
 * for DURING an incident is not acceptable. (A2-319 added
 * `PATCH /admin/keys/:id/rate-limit`, which invalidates this cache on write;
 * the 10s TTL remains the bound for a row edited by hand.)
 * This service therefore reads the column itself behind its own 10-second TTL
 * cache: the DB stays the authority, staleness is bounded at 10s, and an
 * attacker cannot turn the limiter into a query-per-request DB amplifier.
 */

/** Requests-per-window interpretation of `ApiKey.rateLimit`. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** Bounded staleness of the limit value read from Postgres. */
export const LIMIT_CACHE_TTL_MS = 10_000;

/**
 * Schema default (`prisma/schema.prisma`, `rateLimit Int @default(60)`), used
 * only when the row cannot be read — see `resolveLimit`.
 */
export const FALLBACK_RATE_LIMIT = 60;

/**
 * DEC-AUP-0050 R7 control (b) — ABORT budget window and threshold.
 *
 * An aborted attempt is the expensive failure: the provider read the whole
 * prompt and bills for the complete response even though nobody received it
 * (https://openrouter.ai/docs/api_reference/streaming; `/execute` has no
 * streaming at all, so EVERY aborted `/execute` is a billable one).
 *
 * The threshold is NOT derived from a measured abort baseline, because there is
 * none: 478 requests over ten days of dev traffic contain **zero** `timeout`
 * rows (125 of the 132 errors are `circuit_open`, which returns from a branch
 * above `fetch` and costs nothing). Deriving a multiple of zero is meaningless,
 * and pretending otherwise would be a guess wearing a measurement's clothes.
 *
 * It is derived from the cost model instead. Without this budget, a key at the
 * default limit can force 60 billable aborts a minute — 300 per five minutes.
 * At 10 per five minutes the sustained ceiling drops by 30x while sitting far
 * above anything measured (zero), so the expected false-refusal rate on real
 * dev traffic is zero. Re-derive from prod once a prod abort rate exists.
 */
export const ABORT_BUDGET_WINDOW_SECONDS = 300;
export const ABORT_BUDGET_THRESHOLD = 10;

export type RateLimitOutcome =
  | 'allowed'
  /** Request counter for this window exceeded `ApiKey.rateLimit`. */
  | 'over_limit'
  /** DEC-AUP-0050 R7 (b): too many billable aborted attempts in the window. */
  | 'abort_budget_exhausted'
  /** Redis unreachable. Fail-closed — see `consume`. */
  | 'backend_unavailable';

export interface RateLimitDecision {
  outcome: RateLimitOutcome;
  /** The limit in force, as read from Postgres. */
  limit: number;
  /** Requests counted in the current window INCLUDING this one. */
  count: number;
  /** Aborted attempts counted in the current abort window. */
  abortCount: number;
  /** Seconds until the relevant window rolls over. Never 0 (RFC 9110 sanity). */
  retryAfterSeconds: number;
}

@Injectable()
export class KeyRateLimitService {
  private readonly logger = new Logger(KeyRateLimitService.name);
  private readonly limitCache = new Map<string, { limit: number; expiresAt: number }>();

  constructor(
    @Inject(KEY_RATE_LIMIT_REDIS_CLIENT) private readonly redis: IKeyRateLimitRedis,
    private readonly prisma: PrismaService,
  ) {}

  /** Test/admin seam: drop the cached limits so the next read hits Postgres. */
  flushLimitCache(): void {
    this.limitCache.clear();
  }

  /**
   * A2-319 — drop ONE key's cached limit. Called by the admin write path
   * (`PATCH /admin/keys/:id/rate-limit`) so a changed limit is in force on the
   * very next request instead of after up to {@link LIMIT_CACHE_TTL_MS}. The
   * 10s bound still covers the only other writer: a hand-edited row.
   */
  invalidateLimit(keyId: string): void {
    this.limitCache.delete(keyId);
  }

  /**
   * The limit in force for a key. Cached for {@link LIMIT_CACHE_TTL_MS}.
   *
   * A missing row falls back to the schema default rather than refusing: by the
   * time we are here `AuthGuard` has already accepted the key, so a vanished row
   * is a delete racing an in-flight request, and turning that race into a 5xx
   * would be a worse failure than applying the default for up to 10 seconds. It
   * is logged, because it should not happen quietly.
   */
  async resolveLimit(keyId: string): Promise<number> {
    const cached = this.limitCache.get(keyId);
    if (cached && cached.expiresAt > Date.now()) return cached.limit;

    const row = await this.prisma.apiKey.findUnique({
      where: { id: keyId },
      select: { rateLimit: true },
    });
    if (!row) {
      this.logger.warn(
        `rate limit: no ApiKey row for keyId=${keyId}; applying default ${FALLBACK_RATE_LIMIT}/` +
          `${RATE_LIMIT_WINDOW_SECONDS}s`,
      );
    }
    const limit = row?.rateLimit ?? FALLBACK_RATE_LIMIT;
    this.limitCache.set(keyId, { limit, expiresAt: Date.now() + LIMIT_CACHE_TTL_MS });
    return limit;
  }

  /**
   * Counts one request against the key's window and returns what to do with it.
   *
   * **Fail-closed on a Redis error, and it costs nothing extra.** The usual
   * objection — "a limiter outage must not become a service outage" — does not
   * apply to this service: `/execute` enqueues onto BullMQ
   * (`connectors.service.ts:1192`) backed by the SAME Redis, so when Redis is
   * down the paid paths are already returning `queue_timeout`/503. Failing open
   * would therefore buy no availability at all and would hand an attacker the
   * exact bypass this control exists to close (knock Redis over, then spend
   * without limit). The refusal is a 503, never a 429: telling a caller they
   * exceeded a quota they did not exceed would be a false statement about their
   * own usage, and their backoff logic branches on it.
   */
  async consume(keyId: string): Promise<RateLimitDecision> {
    const limit = await this.resolveLimit(keyId);
    const nowMs = Date.now();
    const requestKey = this.requestKey(keyId, nowMs);
    const abortKey = this.abortKey(keyId, nowMs);

    try {
      // One round trip: count this request, keep the counter alive for two
      // windows (so a rollover cannot orphan a key), and read the abort tally.
      const results = await this.redis
        .multi()
        .incr(requestKey)
        .expire(requestKey, RATE_LIMIT_WINDOW_SECONDS * 2)
        .get(abortKey)
        .exec();

      if (!results) throw new Error('Redis MULTI returned null (connection lost mid-transaction)');
      const firstErr = results.find(([err]) => err != null)?.[0];
      if (firstErr) throw firstErr;

      const count = toInt(results[0]?.[1]);
      const abortCount = toInt(results[2]?.[1]);

      // Abort budget is checked AFTER the increment so an abusing key still has
      // its requests counted (the two windows are independent ledgers), but it
      // is reported FIRST because it is the more specific reason for refusal.
      if (abortCount >= ABORT_BUDGET_THRESHOLD) {
        return {
          outcome: 'abort_budget_exhausted',
          limit,
          count,
          abortCount,
          retryAfterSeconds: secondsToWindowEnd(nowMs, ABORT_BUDGET_WINDOW_SECONDS),
        };
      }

      return {
        outcome: count > limit ? 'over_limit' : 'allowed',
        limit,
        count,
        abortCount,
        retryAfterSeconds: secondsToWindowEnd(nowMs, RATE_LIMIT_WINDOW_SECONDS),
      };
    } catch (err) {
      this.logger.error(
        `rate limit: Redis unavailable, failing CLOSED for keyId=${keyId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        outcome: 'backend_unavailable',
        limit,
        count: 0,
        abortCount: 0,
        retryAfterSeconds: secondsToWindowEnd(nowMs, RATE_LIMIT_WINDOW_SECONDS),
      };
    }
  }

  /**
   * DEC-AUP-0050 R7 (b) — records one billable aborted attempt against the key.
   *
   * Never throws: this runs while an already-failed request is on its way out,
   * and a Redis hiccup here must not replace the caller's timeout envelope with
   * a limiter error. A lost increment only makes the budget more permissive,
   * which is the safe direction for a bookkeeping failure.
   */
  async recordAbort(keyId: string): Promise<void> {
    const key = this.abortKey(keyId, Date.now());
    try {
      const results = await this.redis
        .multi()
        .incr(key)
        .expire(key, ABORT_BUDGET_WINDOW_SECONDS * 2)
        .exec();
      const count = toInt(results?.[0]?.[1]);
      this.logger.warn(
        `abort budget: billable aborted attempt keyId=${keyId} ` +
          `count=${count}/${ABORT_BUDGET_THRESHOLD} window=${ABORT_BUDGET_WINDOW_SECONDS}s`,
      );
    } catch (err) {
      this.logger.error(
        `abort budget: failed to record abort for keyId=${keyId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** `<REDIS_PREFIX>rl:req:<keyId>:<windowOrdinal>` */
  private requestKey(keyId: string, nowMs: number): string {
    return `${getConfig().REDIS_PREFIX}rl:req:${keyId}:${windowOrdinal(nowMs, RATE_LIMIT_WINDOW_SECONDS)}`;
  }

  /** `<REDIS_PREFIX>rl:abort:<keyId>:<windowOrdinal>` */
  private abortKey(keyId: string, nowMs: number): string {
    return `${getConfig().REDIS_PREFIX}rl:abort:${keyId}:${windowOrdinal(nowMs, ABORT_BUDGET_WINDOW_SECONDS)}`;
  }
}

/** Which fixed window `nowMs` falls into. Embedded in the key, never read back. */
export function windowOrdinal(nowMs: number, windowSeconds: number): number {
  return Math.floor(nowMs / 1000 / windowSeconds);
}

/**
 * Seconds until the current fixed window ends, floored at 1.
 *
 * A2-207 established in this repository that `Retry-After: 0` is the one value
 * that makes a well-behaved client hammer instead of wait, so the floor is not
 * cosmetic.
 */
export function secondsToWindowEnd(nowMs: number, windowSeconds: number): number {
  const elapsed = Math.floor(nowMs / 1000) % windowSeconds;
  return Math.max(1, windowSeconds - elapsed);
}

function toInt(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

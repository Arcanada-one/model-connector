import { Inject, Injectable, Logger } from '@nestjs/common';
import { getConfig } from '../../config/env.schema';

/**
 * CONN-0104 — Redis-persistent STT quota cooldown.
 *
 * Replaces the in-memory/Prisma-aggregate budget gate of CONN-0103 (which
 * stays as audit ledger) with a restart-survivable counter pair:
 *   * conn:stt:quota:cost:YYYYMMDD — running micro-cents charge
 *   * conn:stt:quota:req:YYYYMMDD  — running request count
 *
 * Both expire at UTC midnight (TTL = seconds-until-midnight, ≤86400). The
 * pre-check + commit cycle uses `ioredis.multi()` pipeline — atomic from
 * the Redis side, race-bound at ~10ms between client GET and INCRBY when
 * many workers fire simultaneously. Documented in plan § Security T5;
 * monitor stt_quota_overshoot_total to detect drift > 1/day.
 *
 * Self-hosted calls (LocalWhisperSttConnector, costUsd=0) still increment
 * the req counter — useful for audit + per-provider capacity planning even
 * when the cost ledger doesn't move.
 */

export interface PrecheckResult {
  allowed: boolean;
  dailyCostMicroCents: number;
  dailyReqCount: number;
}

// Minimal subset of ioredis we depend on — keeps the spec mock narrow and
// the production wiring obvious. The DI token `STT_REDIS_CLIENT` (declared
// in this module) binds the real ioredis Redis instance.
export interface IRedisPipeline {
  get(key: string): IRedisPipeline;
  incrby(key: string, value: number): IRedisPipeline;
  expire(key: string, seconds: number): IRedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]>>;
}
export interface IRedisLike {
  multi(): IRedisPipeline;
}

export const STT_REDIS_CLIENT = Symbol('STT_REDIS_CLIENT');

const KEY_PREFIX = 'conn:stt:quota';

@Injectable()
export class SttQuotaService {
  private readonly logger = new Logger(SttQuotaService.name);

  constructor(@Inject(STT_REDIS_CLIENT) private readonly redis: IRedisLike) {}

  async precheck(_reqId: string): Promise<PrecheckResult> {
    const { costKey, reqKey } = this.keysForToday();
    const results = await this.redis.multi().get(costKey).get(reqKey).exec();
    const dailyCostMicroCents = parseRedisInt(results[0]);
    const dailyReqCount = parseRedisInt(results[1]);
    const capMicroCents = budgetUsdToMicroCents(this.dailyBudgetUsd());
    const allowed = dailyCostMicroCents < capMicroCents;
    return { allowed, dailyCostMicroCents, dailyReqCount };
  }

  async commit(costMicroCents: number, _reqId: string): Promise<void> {
    const { costKey, reqKey } = this.keysForToday();
    const ttl = secondsUntilUtcMidnight();
    const charge = Math.max(0, Math.trunc(costMicroCents));
    try {
      await this.redis
        .multi()
        .incrby(costKey, charge)
        .incrby(reqKey, 1)
        .expire(costKey, ttl)
        .expire(reqKey, ttl)
        .exec();
    } catch (err) {
      // Quota commit failure must not break a successful transcription.
      // Audit row remains source-of-truth; the next request's precheck
      // re-reads whatever value Redis holds.
      this.logger.warn(
        `STT quota commit failed (cost=${charge}µc): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private dailyBudgetUsd(): number {
    try {
      return getConfig().STT_DAILY_BUDGET_USD;
    } catch {
      return 10;
    }
  }

  private keysForToday(): { costKey: string; reqKey: string } {
    const today = todayUtcStamp();
    return {
      costKey: `${KEY_PREFIX}:cost:${today}`,
      reqKey: `${KEY_PREFIX}:req:${today}`,
    };
  }
}

function parseRedisInt(entry: [Error | null, unknown] | undefined): number {
  if (!entry || entry[0]) return 0;
  const v = entry[1];
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

function budgetUsdToMicroCents(usd: number): number {
  // 1 USD = 100 cents = 100_000_000 micro-cents.
  return Math.trunc(usd * 100_000_000);
}

function todayUtcStamp(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  const secs = Math.ceil((midnight.getTime() - now.getTime()) / 1000);
  return Math.max(1, Math.min(86_400, secs));
}

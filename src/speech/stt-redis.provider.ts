import { Provider } from '@nestjs/common';
import { getConfig } from '../config/env.schema';
import { createRedisClient } from '../common/redis-client';
import { STT_REDIS_CLIENT } from './stt/stt-quota.service';

/**
 * Dedicated Redis client for STT quota counters. Shares the cluster configured
 * for BullMQ (REDIS_HOST/PORT/PASSWORD) but is its own connection — keeps the
 * quota pipeline isolated from BullMQ's blocking reads. STT quota keys already
 * start with `conn:` per convention; `keyPrefix` is omitted so the literal key
 * string is sent verbatim.
 *
 * A2-464 — built through createRedisClient so a connection error is logged as
 * `client=stt-quota` instead of `[ioredis] Unhandled error event`. Queueing is
 * left at ioredis defaults: this client's failure modes were not in scope.
 */
export const STT_REDIS_PROVIDER: Provider = {
  provide: STT_REDIS_CLIENT,
  useFactory: () => createRedisClient('stt-quota', getConfig()),
};

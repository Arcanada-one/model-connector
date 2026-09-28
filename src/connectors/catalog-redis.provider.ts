import { Provider } from '@nestjs/common';
import { getConfig } from '../config/env.schema';
import { cacheFailFastOptions, createRedisClient } from '../common/redis-client';
import { CATALOG_REDIS_CLIENT } from './catalog-redis.token';

/**
 * CONN-0245 — dedicated ioredis connection for the catalog's short-TTL cache
 * layer, mirroring the `STT_REDIS_CLIENT` factory pattern
 * (src/speech/stt-redis.provider.ts). Its own connection, isolated from BullMQ's
 * blocking reads and the STT quota counters.
 *
 * A2-464 — fail-fast: the DB is the source of truth, so a lost Redis must cost
 * at most CACHE_COMMAND_TIMEOUT_MS, not the 41 s ioredis's default offline
 * queue made it cost (A2-462, measured live).
 */
export const CATALOG_REDIS_PROVIDER: Provider = {
  provide: CATALOG_REDIS_CLIENT,
  useFactory: () => createRedisClient('catalog-cache', getConfig(), cacheFailFastOptions()),
};

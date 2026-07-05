import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { getConfig } from '../config/env.schema';
import { CATALOG_REDIS_CLIENT } from './catalog-redis.token';

/**
 * CONN-0245 — dedicated ioredis connection for the catalog's short-TTL cache
 * layer, mirroring the `STT_REDIS_CLIENT` factory pattern
 * (src/speech/speech.module.ts). Its own connection, isolated from BullMQ's
 * blocking reads and the STT quota counters.
 */
export const CATALOG_REDIS_PROVIDER: Provider = {
  provide: CATALOG_REDIS_CLIENT,
  useFactory: () => {
    const cfg = getConfig();
    return new Redis({
      host: cfg.REDIS_HOST,
      port: cfg.REDIS_PORT,
      ...(cfg.REDIS_PASSWORD && { password: cfg.REDIS_PASSWORD }),
      lazyConnect: false,
    });
  },
};

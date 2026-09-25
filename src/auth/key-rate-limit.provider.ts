import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { getConfig } from '../config/env.schema';
import { KEY_RATE_LIMIT_REDIS_CLIENT } from './key-rate-limit.token';

/**
 * A2-301 — dedicated ioredis connection for the per-key rate limiter, built the
 * same way as `CATALOG_REDIS_PROVIDER` (src/connectors/catalog-redis.provider.ts).
 *
 * Its own connection on purpose: the limiter runs on EVERY authenticated request
 * and must not queue behind BullMQ's blocking reads on a shared client.
 */
export const KEY_RATE_LIMIT_REDIS_PROVIDER: Provider = {
  provide: KEY_RATE_LIMIT_REDIS_CLIENT,
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

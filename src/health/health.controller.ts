import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { buildInfo } from './build-info';
import { CATALOG_REDIS_CLIENT, type ICatalogRedis } from '../connectors/catalog-redis.token';
import { describeRedisError } from '../common/redis-client';

/**
 * A2-464 — a readiness probe must itself answer fast when a dependency hangs.
 * Same order as the catalog cache's own CACHE_COMMAND_TIMEOUT_MS; a little
 * above it so the client's own timeout, not this one, is what normally fires.
 */
export const REDIS_PROBE_TIMEOUT_MS = 250;

/**
 * Redis verdicts. `not_measured` is a third value, not a pass: the overall
 * `status` is `ok` only when every check is `ok`.
 */
export type RedisVerdict = 'ok' | 'unavailable' | 'not_measured';

/**
 * What stops working while Redis is unavailable, measured in the code on
 * 2026-09-28 (A2-464). Reported in the body so a 200 cannot be read as
 * "every dependency is fine".
 */
export const REDIS_UNAVAILABLE_IMPACT = [
  'catalog cache bypassed: /connectors/catalog is served from the database',
  'per-key rate limiter fails closed: requests authenticated by API key are refused with 503',
  'async STT and image jobs (BullMQ) and STT quota counters unavailable',
];

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly connectorsService: ConnectorsService,
    @Optional()
    @Inject(CATALOG_REDIS_CLIENT)
    private readonly catalogRedis: Pick<ICatalogRedis, 'ping'> | null = null,
  ) {}

  @Get()
  @Public()
  health() {
    // A2-228: `build` names the commit this process was built from. Measurements taken through
    // this service record it, so a number can never again be attributed to the wrong binary —
    // see src/health/build-info.ts for why `sha: null` is not_measured rather than a pass.
    // A2-464: this is liveness only — it checks nothing, and says so, so a 200 here is never
    // again read as "the dependencies are up" (the premise A2-462 found wrong). Dependencies
    // are answered by /health/ready.
    return {
      status: 'ok',
      scope: 'liveness',
      dependencies: 'not_measured',
      timestamp: new Date().toISOString(),
      build: buildInfo(),
    };
  }

  /**
   * Readiness. `ready` follows the database — the source of truth; without it
   * nothing is served. Redis is reported as a DEGRADATION (status `degraded`,
   * `ready` unchanged) with what it breaks, per A2-464. `status` is `ok` only
   * when every check is `ok`, so `not_measured` never reads as healthy.
   */
  @Get('ready')
  @Public()
  async ready() {
    const checks: { database: 'ok' | 'error'; redis: RedisVerdict } = {
      database: 'error',
      redis: 'not_measured',
    };
    const detail: Record<string, string> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    if (!this.catalogRedis) {
      detail.redis = 'no catalog cache client in this process';
    } else {
      try {
        await withTimeout(this.catalogRedis.ping(), REDIS_PROBE_TIMEOUT_MS);
        checks.redis = 'ok';
      } catch (err) {
        checks.redis = 'unavailable';
        detail.redis = `probe=ping client=catalog-cache ${describeRedisError(err)}`;
      }
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return {
      status: allOk ? 'ok' : 'degraded',
      ready: checks.database === 'ok',
      checks,
      ...(Object.keys(detail).length > 0 && { detail }),
      ...(checks.redis === 'unavailable' && { impact: { redis: REDIS_UNAVAILABLE_IMPACT } }),
    };
  }

  @Get('metrics')
  @Public()
  metrics() {
    return this.metricsService.getAll();
  }

  @Get('connectors')
  @Public()
  async connectorHealth() {
    const names = this.connectorsService.listNames();
    const connectors = await Promise.all(
      names.map(async (name) => {
        try {
          const status = await this.connectorsService.getStatus(name);
          const connector = this.connectorsService.get(name);
          return { ...status, type: connector.type };
        } catch {
          return {
            name,
            type: this.safeGetType(name),
            healthy: false,
            activeJobs: 0,
            queuedJobs: 0,
            rateLimitStatus: 'ok' as const,
            circuitBreaker: {
              state: 'open' as const,
              consecutiveFailures: 0,
              lastErrorType: 'probe_failed',
            },
          };
        }
      }),
    );

    const allHealthy = connectors.every((c) => c.healthy);
    return { status: allHealthy ? 'ok' : 'degraded', connectors };
  }

  private safeGetType(name: string): 'cli' | 'api' {
    try {
      return this.connectorsService.get(name).type;
    } catch {
      return 'cli';
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

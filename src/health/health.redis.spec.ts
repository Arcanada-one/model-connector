import { describe, it, expect, vi } from 'vitest';
import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { MetricsService } from '../metrics/metrics.service';
import type { ConnectorsService } from '../connectors/connectors.service';

/**
 * A2-464 item 3 — health answers about its dependencies. Redis is a
 * degradation (visible in the body), not a failure of readiness; a check that
 * was not made is `not_measured`, and `status` is `ok` only when every check is.
 */

type Ctor = new (...args: unknown[]) => HealthController;

function controller(db: 'up' | 'down', redis: { ping: () => Promise<string> } | null) {
  const prisma = {
    $queryRaw:
      db === 'up'
        ? vi.fn().mockResolvedValue([{ 1: 1 }])
        : vi.fn().mockRejectedValue(new Error('down')),
  };
  return new (HealthController as unknown as Ctor)(
    prisma as unknown as PrismaService,
    {} as unknown as MetricsService,
    {} as unknown as ConnectorsService,
    redis,
  );
}

const up = { ping: vi.fn().mockResolvedValue('PONG') };
const refused = {
  ping: vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
};
const hung = { ping: () => new Promise<string>(() => undefined) };

describe('A2-464 item 3 — /health/ready reports Redis', () => {
  it('DB and Redis up: ok, ready', async () => {
    const r = await controller('up', up).ready();
    expect(r).toMatchObject({ status: 'ok', ready: true, checks: { database: 'ok', redis: 'ok' } });
  });

  it('Redis down: degraded but still ready, and the body says what it breaks', async () => {
    const r = (await controller('up', refused).ready()) as Record<string, unknown> & {
      checks: Record<string, string>;
      detail?: Record<string, string>;
      impact?: Record<string, string[]>;
    };
    expect(r.status).toBe('degraded');
    expect(r.ready).toBe(true);
    expect(r.checks.redis).toBe('unavailable');
    expect(r.detail?.redis).toMatch(/client=catalog-cache/);
    expect(r.detail?.redis).toMatch(/ECONNREFUSED/);
    expect(r.impact?.redis?.join(' ')).toMatch(/rate limiter fails closed/);
  });

  it('Redis hangs: the probe itself answers within its budget', async () => {
    const t0 = Date.now();
    const r = await controller('up', hung).ready();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.checks.redis).toBe('unavailable');
    expect(r.ready).toBe(true);
  });

  it('no Redis client: not_measured, and status is NOT ok', async () => {
    const r = await controller('up', null).ready();
    expect(r.checks.redis).toBe('not_measured');
    expect(r.status).not.toBe('ok');
    expect(r.ready).toBe(true);
  });

  it('DB down: not ready, whatever Redis says', async () => {
    const r = await controller('down', up).ready();
    expect(r.ready).toBe(false);
    expect(r.status).toBe('degraded');
  });

  it('/health is liveness and says it measured no dependency', () => {
    const r = controller('up', up).health() as Record<string, unknown>;
    expect(r.status).toBe('ok');
    expect(r.scope).toBe('liveness');
    expect(r.dependencies).toBe('not_measured');
  });
});

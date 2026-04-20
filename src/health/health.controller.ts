import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { ConnectorsService } from '../connectors/connectors.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly connectorsService: ConnectorsService,
  ) {}

  @Get()
  @Public()
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @Public()
  async ready() {
    const checks: Record<string, 'ok' | 'error'> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return { status: allOk ? 'ok' : 'degraded', checks };
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

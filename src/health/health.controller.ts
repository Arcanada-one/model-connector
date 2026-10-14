import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { buildInfo } from './build-info';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly connectorsService: ConnectorsService,
  ) {}

  @Get()
  @Public()
  async health(@Res({ passthrough: true }) reply: FastifyReply) {
    const providers = this.connectorsService.getProviderCredentialStatus();
    // `/health` is process liveness consumed by Docker, deploy and billing;
    // provider readiness is reported at `/health/ready` below.
    reply.statusCode = 200;
    // A2-228: `build` names the commit this process was built from. Measurements taken through
    // this service record it, so a number can never again be attributed to the wrong binary —
    // see src/health/build-info.ts for why `sha: null` is not_measured rather than a pass.
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      build: buildInfo(),
      providers: providers.map(({ connector, required, state, checkedAt }) => ({
        connector,
        required,
        state,
        checkedAt,
      })),
    };
  }

  @Get('ready')
  @Public()
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const checks: Record<string, 'ok' | 'error'> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    // Readiness must not classify a cold process from an empty credential cache.
    // These probes are non-generative and single-flighted/cached by the connector service.
    await this.connectorsService.checkProviderCredentials();
    const providers = this.connectorsService.getProviderCredentialStatus();
    const requiredUnavailable = providers.some(
      (provider) => provider.required && provider.state !== 'ready',
    );
    const optionalUnavailable = providers.some(
      (provider) => !provider.required && provider.state !== 'ready',
    );
    const anyUnavailable = providers.some((provider) => provider.state !== 'ready');
    checks.requiredProviders = requiredUnavailable ? 'error' : 'ok';
    checks.optionalProviders = optionalUnavailable ? 'error' : 'ok';

    reply.statusCode = requiredUnavailable ? 503 : 200;
    const status = requiredUnavailable
      ? 'error'
      : checks.database === 'error' || anyUnavailable || optionalUnavailable
        ? 'degraded'
        : 'ok';
    return {
      status,
      checks,
      providers: providers.map(({ connector, required, state, checkedAt }) => ({
        connector,
        required,
        state,
        checkedAt,
      })),
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

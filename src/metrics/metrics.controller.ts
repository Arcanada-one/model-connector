import { Controller, Get, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { SpeechMetricsService } from '../speech/speech-metrics.service';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly speechMetrics: SpeechMetricsService,
    private readonly metricsService: MetricsService,
  ) {}

  @Get()
  async metrics(@Res() reply: FastifyReply): Promise<void> {
    // Drain sidecar sentinel file before rendering Prometheus output so
    // writeback_fail and refresh_attempt counters reflect latest sidecar events.
    this.metricsService.drainCodexSentinel();

    const registry = this.speechMetrics.getRegistry();
    const speechBody = await registry.metrics();
    const codexBody = this.metricsService.getPrometheusCodexOauth();
    const body = speechBody + codexBody;
    reply.status(200);
    reply.header('Content-Type', registry.contentType);
    reply.send(body);
  }
}

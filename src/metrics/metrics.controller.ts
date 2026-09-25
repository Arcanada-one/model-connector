import { Controller, Get, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { RateLimitExempt } from '../auth/rate-limit-exempt.decorator';
import { SpeechMetricsService } from '../speech/speech-metrics.service';
import { MetricsService } from './metrics.service';

@Controller('metrics')
// A2-301 — the ONLY route exempted from the per-key rate limit, and the reason
// is the incident this control is for: a scrape budget shared with traffic means
// observability goes dark exactly when a key starts burning through its limit.
// Throttling the monitor during the event it is meant to show is backwards. The
// endpoint exposes no customer data and costs no provider call; the residual
// risk is a cheap read loop by a valid key holder, bounded by the Redis-cached
// registry render and visible in the reverse proxy's own logs.
@RateLimitExempt('Prometheus scrape: observability must not be throttled by a traffic budget')
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

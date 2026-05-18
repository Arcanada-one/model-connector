import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry } from 'prom-client';

export type SpeechEndpoint = 'tts' | 'vad' | 'stt';
export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';

const LATENCY_BUCKETS_MS = [100, 250, 500, 1000, 2500, 5000, 10000, 30000];

function toStatusClass(statusCode: number): StatusClass {
  if (statusCode >= 100 && statusCode < 200) return '1xx';
  if (statusCode >= 200 && statusCode < 300) return '2xx';
  if (statusCode >= 300 && statusCode < 400) return '3xx';
  if (statusCode >= 400 && statusCode < 500) return '4xx';
  return '5xx';
}

@Injectable()
export class SpeechMetricsService {
  private readonly registry = new Registry();
  private readonly counter: Counter<'endpoint' | 'status_class'>;
  private readonly histogram: Histogram<'endpoint'>;

  constructor() {
    this.counter = new Counter({
      name: 'mc_speech_proxy_total',
      help: 'Speech proxy request count by endpoint and HTTP status class',
      labelNames: ['endpoint', 'status_class'] as const,
      registers: [this.registry],
    });
    this.histogram = new Histogram({
      name: 'mc_speech_proxy_latency_ms',
      help: 'Speech proxy end-to-end latency in milliseconds',
      labelNames: ['endpoint'] as const,
      buckets: LATENCY_BUCKETS_MS,
      registers: [this.registry],
    });
  }

  observe(opts: { endpoint: SpeechEndpoint; statusCode: number; latencyMs: number }): void {
    const statusClass = toStatusClass(opts.statusCode);
    this.counter.inc({ endpoint: opts.endpoint, status_class: statusClass });
    this.histogram.observe({ endpoint: opts.endpoint }, opts.latencyMs);
  }

  getRegistry(): Registry {
    return this.registry;
  }
}

import { beforeEach, describe, expect, it } from 'vitest';
import { SpeechMetricsService } from './speech-metrics.service';

const BUCKETS = [100, 250, 500, 1000, 2500, 5000, 10000, 30000];

async function counterValue(
  service: SpeechMetricsService,
  endpoint: string,
  statusClass: string,
): Promise<number> {
  const json = await service.getRegistry().getMetricsAsJSON();
  const counter = json.find((m) => m.name === 'mc_speech_proxy_total');
  if (!counter) return 0;
  const point = counter.values.find(
    (v) => v.labels.endpoint === endpoint && v.labels.status_class === statusClass,
  );
  return point ? Number(point.value) : 0;
}

async function histogramCount(service: SpeechMetricsService, endpoint: string): Promise<number> {
  const json = await service.getRegistry().getMetricsAsJSON();
  const hist = json.find((m) => m.name === 'mc_speech_proxy_latency_ms');
  if (!hist) return 0;
  const point = hist.values.find(
    (v) => v.metricName === 'mc_speech_proxy_latency_ms_count' && v.labels.endpoint === endpoint,
  );
  return point ? Number(point.value) : 0;
}

async function histogramBucketUpperBounds(
  service: SpeechMetricsService,
  endpoint: string,
): Promise<number[]> {
  const json = await service.getRegistry().getMetricsAsJSON();
  const hist = json.find((m) => m.name === 'mc_speech_proxy_latency_ms');
  if (!hist) return [];
  return hist.values
    .filter(
      (v) => v.metricName === 'mc_speech_proxy_latency_ms_bucket' && v.labels.endpoint === endpoint,
    )
    .map((v) => Number(v.labels.le))
    .filter((n) => Number.isFinite(n));
}

describe('SpeechMetricsService', () => {
  let service: SpeechMetricsService;

  beforeEach(() => {
    service = new SpeechMetricsService();
  });

  it('counter increments with status_class=2xx on 200 response', async () => {
    service.observe({ endpoint: 'tts', statusCode: 200, latencyMs: 120 });
    expect(await counterValue(service, 'tts', '2xx')).toBe(1);
  });

  it('counter increments with status_class=4xx on 413 response', async () => {
    service.observe({ endpoint: 'stt', statusCode: 413, latencyMs: 50 });
    expect(await counterValue(service, 'stt', '4xx')).toBe(1);
  });

  it('counter increments with status_class=5xx on 500 response', async () => {
    service.observe({ endpoint: 'vad', statusCode: 500, latencyMs: 800 });
    expect(await counterValue(service, 'vad', '5xx')).toBe(1);
  });

  it('histogram observes one sample per call on the matching endpoint', async () => {
    service.observe({ endpoint: 'tts', statusCode: 200, latencyMs: 120 });
    service.observe({ endpoint: 'tts', statusCode: 200, latencyMs: 700 });
    service.observe({ endpoint: 'vad', statusCode: 200, latencyMs: 30 });
    expect(await histogramCount(service, 'tts')).toBe(2);
    expect(await histogramCount(service, 'vad')).toBe(1);
  });

  it('histogram exposes the documented 8 buckets', async () => {
    service.observe({ endpoint: 'tts', statusCode: 200, latencyMs: 50 });
    const bounds = await histogramBucketUpperBounds(service, 'tts');
    expect(bounds).toEqual(BUCKETS);
  });

  it('registry exposes Prometheus text format with both series', async () => {
    service.observe({ endpoint: 'tts', statusCode: 200, latencyMs: 120 });
    const text = await service.getRegistry().metrics();
    expect(text).toContain('mc_speech_proxy_total');
    expect(text).toContain('mc_speech_proxy_latency_ms');
    expect(text).toMatch(
      /mc_speech_proxy_total\{[^}]*endpoint="tts"[^}]*status_class="2xx"[^}]*\} 1/,
    );
  });

  it('each service instance owns an isolated registry (no cross-leak)', async () => {
    const a = new SpeechMetricsService();
    const b = new SpeechMetricsService();
    a.observe({ endpoint: 'tts', statusCode: 200, latencyMs: 100 });
    expect(await counterValue(a, 'tts', '2xx')).toBe(1);
    expect(await counterValue(b, 'tts', '2xx')).toBe(0);
  });
});

import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { GroqSttConnector } from './groq-stt.connector';
import {
  SttAllProvidersExhausted,
  SttProviderError,
  SttUnsupportedMimeError,
  SttAudioTooLargeError,
} from './stt-pilot.errors';
import { STT_ALLOWED_MIME_TYPES } from '../dto/stt-request.dto';
import { getConfig } from '../../config/env.schema';
import type {
  ISttConnector,
  SttConnectorRequest,
  SttConnectorResult,
} from './interfaces/stt-connector.interface';
import type { SttSuccessResponse } from '../dto/stt-response.dto';

/** Phase 1b will swap this for ConnectorsService.getStt(). For Phase 1a we keep
 * the registry inline so we don't need cross-module DI churn until cascade
 * actually lands. */
function buildRegistry(groq: GroqSttConnector): Map<string, ISttConnector> {
  return new Map<string, ISttConnector>([['groq', groq]]);
}

@Injectable()
export class SttRouterService {
  private readonly logger = new Logger(SttRouterService.name);
  private readonly registry: Map<string, ISttConnector>;
  private dailyCostWarningEmitted = false;

  constructor(
    groqStt: GroqSttConnector,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {
    this.registry = buildRegistry(groqStt);
  }

  /** @internal Test seam — replaces the registry; spec injects a fake ISttConnector. */
  setRegistry(map: Map<string, ISttConnector>): void {
    this.registry.clear();
    for (const [k, v] of map) this.registry.set(k, v);
  }

  async transcribe(request: SttConnectorRequest, apiKeyId: string): Promise<SttSuccessResponse> {
    this.validateMime(request.mimeType);
    this.validateSize(request.audioBytes);

    const config = this.tryConfig();
    const order = this.parseProvidersOrder(config?.STT_PROVIDERS_ORDER ?? 'groq');
    const multi = config?.STT_MULTI_PROVIDER ?? false;
    const candidates = this.filterEnabled(order, config);
    if (candidates.length === 0) {
      this.logger.error('No STT provider enabled');
      throw new SttAllProvidersExhausted([]);
    }

    const tried: string[] = [];
    let lastErr: SttProviderError | undefined;

    for (const providerName of candidates) {
      const connector = this.registry.get(providerName);
      if (!connector) {
        this.logger.warn(`Provider "${providerName}" listed in order but not registered — skip`);
        continue;
      }
      tried.push(providerName);
      try {
        const result = await connector.transcribe(request);
        await this.persist(request, connector, result, apiKeyId, 'success');
        this.recordMetrics(connector.provider, result.model, 'success', result);
        await this.checkDailyBudget(config);
        return this.toEnvelope(connector, result, request, tried.length - 1);
      } catch (err) {
        if (err instanceof SttProviderError) {
          lastErr = err;
          this.logger.warn(`STT provider ${providerName} failed (${err.type}): ${err.message}`);
          await this.persistFailure(request, connector, err, apiKeyId);
          this.recordMetrics(
            connector.provider,
            request.model ?? 'unknown',
            'error',
            undefined,
            err,
          );
          if (!multi) break;
          continue;
        }
        throw err;
      }
    }

    throw new SttAllProvidersExhausted(tried, lastErr);
  }

  private validateMime(mime: string): void {
    if (!(STT_ALLOWED_MIME_TYPES as readonly string[]).includes(mime)) {
      throw new SttUnsupportedMimeError(mime, STT_ALLOWED_MIME_TYPES);
    }
  }

  private validateSize(audioBytes: number): void {
    const max = this.tryConfig()?.STT_MAX_AUDIO_BYTES ?? 26_214_400;
    if (audioBytes > max) {
      throw new SttAudioTooLargeError(audioBytes, max);
    }
  }

  private parseProvidersOrder(raw: string): string[] {
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }

  private filterEnabled(
    order: string[],
    config: ReturnType<typeof getConfig> | undefined,
  ): string[] {
    return order.filter((name) => {
      if (name === 'groq') return config?.STT_PROVIDER_GROQ_ENABLED ?? true;
      // Phase 1b adds: deepgram / assemblyai / openai gates.
      return true;
    });
  }

  private toEnvelope(
    connector: ISttConnector,
    result: SttConnectorResult,
    request: SttConnectorRequest,
    fallbackCount: number,
  ): SttSuccessResponse {
    return {
      transcription: result.transcription,
      model: result.model,
      provider: connector.provider as 'groq',
      language: result.detectedLanguage,
      latency_ms: result.latencyMs,
      cost_usd: Number(result.costUsd.toFixed(6)),
      audio_duration_seconds: result.audioDurationSeconds,
      fallback_count: fallbackCount,
      request_id: request.requestId,
    };
  }

  private async persist(
    request: SttConnectorRequest,
    connector: ISttConnector,
    result: SttConnectorResult,
    apiKeyId: string,
    status: 'success' | 'error',
  ): Promise<void> {
    try {
      await this.prisma.sttTranscription.create({
        data: {
          id: uuidv7(),
          apiKeyId,
          provider: connector.provider,
          model: result.model,
          language: result.detectedLanguage,
          audioBytes: request.audioBytes,
          audioDurationSeconds: result.audioDurationSeconds,
          mimeType: request.mimeType,
          transcriptionPreview: result.transcription.slice(0, 80),
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          status,
          requestId: request.requestId,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to persist SttTranscription row: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async persistFailure(
    request: SttConnectorRequest,
    connector: ISttConnector,
    err: SttProviderError,
    apiKeyId: string,
  ): Promise<void> {
    try {
      await this.prisma.sttTranscription.create({
        data: {
          id: uuidv7(),
          apiKeyId,
          provider: connector.provider,
          model: request.model ?? 'unknown',
          audioBytes: request.audioBytes,
          mimeType: request.mimeType,
          transcriptionPreview: '',
          costUsd: 0,
          latencyMs: 0,
          status: 'error',
          errorType: err.type,
          errorMessage: err.message.slice(0, 500),
          requestId: request.requestId,
        },
      });
    } catch (persistErr) {
      this.logger.error(
        `Failed to persist STT error row: ${
          persistErr instanceof Error ? persistErr.message : String(persistErr)
        }`,
      );
    }
  }

  private recordMetrics(
    provider: string,
    model: string,
    status: 'success' | 'error',
    result?: SttConnectorResult,
    err?: SttProviderError,
  ): void {
    this.metrics.recordStt({
      provider,
      model,
      status,
      audioDurationSeconds: result?.audioDurationSeconds ?? 0,
      costUsd: result?.costUsd ?? 0,
      latencyMs: result?.latencyMs ?? 0,
      errorType: err?.type,
    });
  }

  async getDailyCostUsd(): Promise<number> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    try {
      const agg = await this.prisma.sttTranscription.aggregate({
        where: { createdAt: { gte: since }, status: 'success' },
        _sum: { costUsd: true },
      });
      const sum = agg._sum.costUsd;
      return sum ? Number(sum) : 0;
    } catch (err) {
      this.logger.warn(
        `Failed to aggregate STT daily cost: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  private async checkDailyBudget(config: ReturnType<typeof getConfig> | undefined): Promise<void> {
    if (!config) return;
    const dailyCost = await this.getDailyCostUsd();
    const threshold = config.STT_DAILY_BUDGET_USD * config.STT_COST_WARN_THRESHOLD_PCT;
    if (dailyCost >= threshold && !this.dailyCostWarningEmitted) {
      this.dailyCostWarningEmitted = true;
      const pct = Math.round((dailyCost / config.STT_DAILY_BUDGET_USD) * 100);
      this.logger.warn(
        `STT daily cost reached ${pct}% of baseline ($${dailyCost.toFixed(4)} / $${config.STT_DAILY_BUDGET_USD}). Phase 1a — soft-warn only, no 503.`,
      );
    }
    // Reset latch at next UTC day — kept simple; cron-level reset added in Phase 1b.
  }

  private tryConfig(): ReturnType<typeof getConfig> | undefined {
    try {
      return getConfig();
    } catch {
      return undefined;
    }
  }
}

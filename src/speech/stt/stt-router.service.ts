import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../metrics/metrics.service';
import { GroqSttConnector } from './groq-stt.connector';
import { DeepgramSttConnector } from './deepgram-stt.connector';
import { AssemblyAiSttConnector } from './assemblyai-stt.connector';
import { OpenAiSttConnector } from './openai-stt.connector';
import { STT_RESPONSE_SCHEMAS } from './schemas';
import {
  SttAllProvidersExhausted,
  SttBudgetExhaustedError,
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
import type { SttSuccessResponse, SttProvider } from '../dto/stt-response.dto';

type DriftStatus = 'schema_pass' | 'schema_fail';

interface CascadeAttemptOutcome {
  result?: SttConnectorResult;
  driftStatus?: DriftStatus;
}

/**
 * CONN-0103 — STT routing surface.
 *
 * Phase 1a wired only Groq. Phase 1b adds Deepgram / AssemblyAI / OpenAI,
 * cascade fallback (gated by STT_MULTI_PROVIDER), Zod drift detection
 * (mismatch → cascade as retryable), hard daily-cost CB (HTTP 503 via
 * SttBudgetExhaustedError before outbound HTTP fires).
 */
function buildRegistry(
  groq: GroqSttConnector,
  deepgram: DeepgramSttConnector,
  assemblyai: AssemblyAiSttConnector,
  openai: OpenAiSttConnector,
): Map<string, ISttConnector> {
  return new Map<string, ISttConnector>([
    ['groq', groq],
    ['deepgram', deepgram],
    ['assemblyai', assemblyai],
    ['openai', openai],
  ]);
}

@Injectable()
export class SttRouterService {
  private readonly logger = new Logger(SttRouterService.name);
  private readonly registry: Map<string, ISttConnector>;
  private dailyCostWarningEmitted = false;

  constructor(
    groqStt: GroqSttConnector,
    deepgramStt: DeepgramSttConnector,
    assemblyAiStt: AssemblyAiSttConnector,
    openAiStt: OpenAiSttConnector,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {
    this.registry = buildRegistry(groqStt, deepgramStt, assemblyAiStt, openAiStt);
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
    // Hard CB pre-loop — before any outbound HTTP egress.
    await this.checkBudgetOrThrow(config);

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
        const outcome = await this.attemptProvider(connector, request);
        const result = outcome.result;
        if (!result) {
          // Drift: schema mismatch — surface as retryable provider error and cascade.
          lastErr = new SttProviderError(
            connector.provider,
            'drift',
            `${connector.provider} response failed schema validation`,
          );
          this.recordMetrics(
            connector.provider,
            request.model ?? 'unknown',
            'error',
            undefined,
            lastErr,
          );
          await this.persistFailure(
            request,
            connector,
            lastErr,
            apiKeyId,
            'schema_fail',
            tried.length - 1,
          );
          if (!multi) break;
          continue;
        }
        await this.persist(
          request,
          connector,
          result,
          apiKeyId,
          'success',
          outcome.driftStatus,
          tried.length - 1,
        );
        this.recordMetrics(connector.provider, result.model, 'success', result);
        await this.checkDailyBudget(config);
        return this.toEnvelope(connector, result, request, tried.length - 1);
      } catch (err) {
        if (err instanceof SttBudgetExhaustedError) throw err;
        if (err instanceof SttProviderError) {
          lastErr = err;
          this.logger.warn(`STT provider ${providerName} failed (${err.type}): ${err.message}`);
          await this.persistFailure(request, connector, err, apiKeyId, undefined, tried.length - 1);
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

  private async attemptProvider(
    connector: ISttConnector,
    request: SttConnectorRequest,
  ): Promise<CascadeAttemptOutcome> {
    const result = await connector.transcribe(request);
    const drift = this.detectDrift(connector.provider, result);
    if (drift === 'schema_fail') return { driftStatus: 'schema_fail' };
    return { result, driftStatus: 'schema_pass' };
  }

  /**
   * Drift detection: compares the connector's already-parsed result against
   * the schema registered for the provider. We do NOT have the raw response
   * here — instead we synthesise the minimal envelope-mappable shape and
   * verify required fields exist with the right type. If a provider has no
   * schema registered (e.g. Groq Phase 1a), drift is skipped (pass).
   */
  private detectDrift(provider: string, result: SttConnectorResult): DriftStatus {
    const schema = STT_RESPONSE_SCHEMAS[provider];
    if (!schema) return 'schema_pass';
    // The synthetic shape mirrors the most defensive subset of each
    // provider's response. If parsing failed downstream, the shape would
    // miss the required field — Zod catches it.
    const projection = this.projectForSchema(provider, result);
    const parsed = schema.safeParse(projection);
    if (!parsed.success) {
      this.logger.warn(
        `STT drift detected for ${provider}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
      return 'schema_fail';
    }
    return 'schema_pass';
  }

  private projectForSchema(provider: string, result: SttConnectorResult): unknown {
    switch (provider) {
      case 'deepgram':
        return {
          metadata: {
            request_id: result.providerRequestId ?? '',
            duration: result.audioDurationSeconds,
          },
          results: {
            channels: [
              {
                alternatives: [{ transcript: result.transcription }],
              },
            ],
          },
        };
      case 'assemblyai':
        return {
          id: result.providerRequestId ?? '',
          status: 'completed',
          text: result.transcription,
          audio_duration: result.audioDurationSeconds,
          language_code: result.detectedLanguage,
        };
      case 'openai':
        return { text: result.transcription };
      default:
        return result;
    }
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
      switch (name) {
        case 'groq':
          return config?.STT_PROVIDER_GROQ_ENABLED ?? true;
        case 'deepgram':
          return config?.STT_PROVIDER_DEEPGRAM_ENABLED ?? false;
        case 'assemblyai':
          return config?.STT_PROVIDER_ASSEMBLYAI_ENABLED ?? false;
        case 'openai':
          return config?.STT_PROVIDER_OPENAI_ENABLED ?? false;
        default:
          return false;
      }
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
      provider: connector.provider as SttProvider,
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
    driftStatus: DriftStatus | undefined,
    fallbackCount: number,
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
          fallbackCount,
          driftStatus: driftStatus ?? null,
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
    driftStatus: DriftStatus | undefined,
    fallbackCount: number,
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
          fallbackCount,
          driftStatus: driftStatus ?? null,
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

  /**
   * CONN-0103 hard CB: throws `SttBudgetExhaustedError` (→ HTTP 503) BEFORE
   * the cascade loop runs. Soft-warn latch is still maintained by
   * `checkDailyBudget` after a successful attempt.
   */
  private async checkBudgetOrThrow(
    config: ReturnType<typeof getConfig> | undefined,
  ): Promise<void> {
    if (!config) return;
    const dailyCost = await this.getDailyCostUsd();
    if (dailyCost >= config.STT_DAILY_BUDGET_USD) {
      throw new SttBudgetExhaustedError(dailyCost, config.STT_DAILY_BUDGET_USD);
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
        `STT daily cost reached ${pct}% of baseline ($${dailyCost.toFixed(4)} / $${config.STT_DAILY_BUDGET_USD}). Soft-warn threshold tripped.`,
      );
    }
  }

  private tryConfig(): ReturnType<typeof getConfig> | undefined {
    try {
      return getConfig();
    } catch {
      return undefined;
    }
  }
}

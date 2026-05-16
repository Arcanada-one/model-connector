import { Injectable, Logger } from '@nestjs/common';
import { Semaphore, QueueTimeoutError } from '../../connectors/base-cli.connector';
import { CircuitBreakerManager } from '../../core/resilience/circuit-breaker-manager';
import { CircuitOpenError } from '../../core/resilience/circuit-breaker';
import { getConfig } from '../../config/env.schema';
import { SttProviderError, type SttProviderErrorType } from './stt-pilot.errors';
import type {
  ISttConnector,
  SttConnectorRequest,
  SttConnectorResult,
  SttConnectorStatus,
} from './interfaces/stt-connector.interface';

interface AaiUploadResponse {
  upload_url?: string;
}

interface AaiTranscriptResponse {
  id?: string;
  status?: 'queued' | 'processing' | 'completed' | 'error';
  text?: string;
  language_code?: string;
  audio_duration?: number;
  error?: string;
}

const DEFAULT_AAI_BASE_URL = 'https://api.assemblyai.com';
const DEFAULT_AAI_MODEL = 'universal-2';

/**
 * CONN-0103 — AssemblyAI STT connector (two-step pattern, encapsulated).
 *
 * Public contract: same `transcribe(request) → Promise<SttConnectorResult>`
 * as every other ISttConnector. Internal flow:
 *   1. POST /v2/upload (raw bytes) → upload_url
 *   2. POST /v2/transcript {audio_url, speech_model} → transcript id
 *   3. Poll GET /v2/transcript/<id> until status=completed (or error)
 *
 * Polling interval: `STT_ASSEMBLYAI_POLL_INTERVAL_MS` (default 2 s).
 * Hard timeout: `STT_ASSEMBLYAI_TIMEOUT_MS` (default 120 s, covers upload +
 * transcribe + polling).
 *
 * Does NOT extend BaseSttConnector — two-step shape doesn't fit the
 * single-call abstraction. We replicate the Semaphore + CircuitBreaker +
 * error classification pipeline here.
 */
@Injectable()
export class AssemblyAiSttConnector implements ISttConnector {
  readonly name = 'assemblyai-stt';
  readonly provider = 'assemblyai';

  private readonly logger = new Logger(AssemblyAiSttConnector.name);
  protected activeJobs = 0;
  private _semaphore?: Semaphore;
  private _cbManager?: CircuitBreakerManager;

  protected getBaseUrl(): string {
    return DEFAULT_AAI_BASE_URL;
  }

  private getApiKey(): string {
    try {
      return getConfig().STT_ASSEMBLYAI_API_KEY ?? process.env.STT_ASSEMBLYAI_API_KEY ?? '';
    } catch {
      return process.env.STT_ASSEMBLYAI_API_KEY ?? '';
    }
  }

  private getDefaultModel(): string {
    try {
      return getConfig().STT_ASSEMBLYAI_MODEL;
    } catch {
      return DEFAULT_AAI_MODEL;
    }
  }

  private getTimeoutMs(): number {
    try {
      return getConfig().STT_ASSEMBLYAI_TIMEOUT_MS;
    } catch {
      return 120_000;
    }
  }

  private getPollIntervalMs(): number {
    try {
      return getConfig().STT_ASSEMBLYAI_POLL_INTERVAL_MS;
    } catch {
      return 2_000;
    }
  }

  private getMaxConcurrency(): number {
    try {
      return getConfig().STT_ASSEMBLYAI_MAX_CONCURRENCY;
    } catch {
      return 5;
    }
  }

  private getPricePerMin(): number {
    try {
      return getConfig().STT_ASSEMBLYAI_PRICE_USD_PER_MIN;
    } catch {
      return 0.0045;
    }
  }

  private getQueueTimeoutMs(): number {
    try {
      return getConfig().CONNECTOR_QUEUE_TIMEOUT_MS;
    } catch {
      return 60_000;
    }
  }

  private get semaphore(): Semaphore {
    if (!this._semaphore) {
      this._semaphore = new Semaphore(this.getMaxConcurrency());
    }
    return this._semaphore;
  }

  /** @internal Testing only — override concurrency cap. */
  setSemaphore(max: number): void {
    this._semaphore = new Semaphore(max);
  }

  private get cbManager(): CircuitBreakerManager {
    if (!this._cbManager) {
      try {
        const c = getConfig();
        this._cbManager = new CircuitBreakerManager(
          this.name,
          c.CIRCUIT_BREAKER_THRESHOLD,
          c.CIRCUIT_BREAKER_COOLDOWN_MS,
        );
      } catch {
        this._cbManager = new CircuitBreakerManager(this.name, 5, 30_000);
      }
    }
    return this._cbManager;
  }

  async transcribe(request: SttConnectorRequest): Promise<SttConnectorResult> {
    const cbKey = request.model ?? 'default';
    const cb = this.cbManager.getCircuitBreaker(cbKey);

    try {
      cb.check();
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        throw new SttProviderError(
          this.provider,
          'server_error',
          `Circuit breaker open for ${this.name}:${cbKey}`,
        );
      }
      throw err;
    }

    try {
      await this.semaphore.acquire(this.getQueueTimeoutMs());
    } catch (err) {
      if (err instanceof QueueTimeoutError) {
        throw new SttProviderError(this.provider, 'timeout', err.message);
      }
      throw err;
    }

    const overallTimeout = request.timeoutMs ?? this.getTimeoutMs();
    const start = Date.now();
    const deadline = start + overallTimeout;
    this.activeJobs++;

    try {
      const uploadUrl = await this.uploadAudio(request, deadline, cb);
      const transcriptId = await this.submitTranscript(uploadUrl, request, deadline, cb);
      const completed = await this.pollTranscript(transcriptId, deadline, cb);

      const latencyMs = Date.now() - start;
      const transcription = (completed.text ?? '').trim();
      const audioDurationSeconds = completed.audio_duration;
      cb.recordSuccess();

      return {
        transcription,
        detectedLanguage: completed.language_code ?? request.language,
        audioDurationSeconds,
        model: request.model ?? this.getDefaultModel(),
        costUsd: this.computeCost(audioDurationSeconds),
        latencyMs,
        providerRequestId: completed.id,
      };
    } finally {
      this.activeJobs--;
      this.semaphore.release();
    }
  }

  private async uploadAudio(
    request: SttConnectorRequest,
    deadline: number,
    cb: ReturnType<CircuitBreakerManager['getCircuitBreaker']>,
  ): Promise<string> {
    const copy = new Uint8Array(request.file.byteLength);
    copy.set(request.file);
    const res = await this.fetchWithDeadline(
      `${this.getBaseUrl()}/v2/upload`,
      {
        method: 'POST',
        headers: {
          Authorization: this.getApiKey(),
          'Content-Type': request.mimeType,
        },
        body: copy,
      },
      deadline,
      cb,
    );
    const json = (await res.json()) as AaiUploadResponse;
    if (!json.upload_url) {
      cb.recordFailure('parse_error');
      throw new SttProviderError(
        this.provider,
        'parse_error',
        'AssemblyAI /v2/upload response missing upload_url',
      );
    }
    return json.upload_url;
  }

  private async submitTranscript(
    uploadUrl: string,
    request: SttConnectorRequest,
    deadline: number,
    cb: ReturnType<CircuitBreakerManager['getCircuitBreaker']>,
  ): Promise<string> {
    const body = JSON.stringify({
      audio_url: uploadUrl,
      speech_model: request.model ?? this.getDefaultModel(),
      ...(request.language ? { language_code: request.language } : {}),
    });
    const res = await this.fetchWithDeadline(
      `${this.getBaseUrl()}/v2/transcript`,
      {
        method: 'POST',
        headers: {
          Authorization: this.getApiKey(),
          'Content-Type': 'application/json',
        },
        body,
      },
      deadline,
      cb,
    );
    const json = (await res.json()) as AaiTranscriptResponse;
    if (!json.id) {
      cb.recordFailure('parse_error');
      throw new SttProviderError(
        this.provider,
        'parse_error',
        'AssemblyAI /v2/transcript response missing id',
      );
    }
    return json.id;
  }

  private async pollTranscript(
    id: string,
    deadline: number,
    cb: ReturnType<CircuitBreakerManager['getCircuitBreaker']>,
  ): Promise<AaiTranscriptResponse> {
    const interval = this.getPollIntervalMs();
    while (Date.now() < deadline) {
      const res = await this.fetchWithDeadline(
        `${this.getBaseUrl()}/v2/transcript/${id}`,
        { method: 'GET', headers: { Authorization: this.getApiKey() } },
        deadline,
        cb,
      );
      const json = (await res.json()) as AaiTranscriptResponse;
      if (json.status === 'completed') return json;
      if (json.status === 'error') {
        cb.recordFailure('server_error');
        throw new SttProviderError(
          this.provider,
          'server_error',
          `AssemblyAI transcript error: ${json.error ?? 'unknown'}`,
        );
      }
      await this.delay(Math.min(interval, Math.max(deadline - Date.now(), 0)));
    }
    cb.recordFailure('timeout');
    throw new SttProviderError(
      this.provider,
      'timeout',
      `AssemblyAI polling timeout after ${this.getTimeoutMs()} ms`,
    );
  }

  private async fetchWithDeadline(
    url: string,
    init: RequestInit,
    deadline: number,
    cb: ReturnType<CircuitBreakerManager['getCircuitBreaker']>,
  ): Promise<Response> {
    const remaining = Math.max(deadline - Date.now(), 1);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(remaining) });
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      const errType: SttProviderErrorType = isAbort ? 'timeout' : 'network_error';
      cb.recordFailure(errType);
      const msg = err instanceof Error ? err.message : String(err);
      throw new SttProviderError(this.provider, errType, msg);
    }
    if (!res.ok) {
      const text = await res.text();
      const errType = this.classifyHttpError(res.status);
      if (this.shouldCountTowardCircuitBreaker(res.status)) {
        cb.recordFailure(errType);
      }
      throw new SttProviderError(
        this.provider,
        errType,
        `AssemblyAI responded ${res.status}: ${text.slice(0, 200)}`,
        undefined,
        res.status,
      );
    }
    return res;
  }

  private classifyHttpError(status: number): SttProviderErrorType {
    if (status === 429) return 'rate_limited';
    if (status === 408) return 'timeout';
    if (status === 401 || status === 403) return 'auth_failed';
    if (status >= 500) return 'server_error';
    return 'http_error';
  }

  private shouldCountTowardCircuitBreaker(status: number): boolean {
    if (status >= 500) return true;
    if (status === 429 || status === 408) return true;
    return false;
  }

  private computeCost(audioDurationSeconds: number | undefined): number {
    if (audioDurationSeconds === undefined || audioDurationSeconds <= 0) return 0;
    return (audioDurationSeconds / 60) * this.getPricePerMin();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getStatus(): Promise<SttConnectorStatus> {
    const { aggregate } = this.cbManager.getStates();
    return {
      name: this.name,
      healthy: aggregate.state !== 'open' && this.getApiKey() !== '',
      activeJobs: this.activeJobs,
      queuedJobs: this.semaphore.pending,
      circuitBreaker: aggregate,
    };
  }

  /** @internal Logger access for tests. */
  protected getLogger(): Logger {
    return this.logger;
  }
}

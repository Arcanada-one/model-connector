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

/**
 * BaseSttConnector — common pipeline for STT providers:
 * Semaphore (per-provider concurrency cap) → CircuitBreaker (per-model)
 * → fetch multipart → parse. Subclasses implement
 * buildMultipartBody/parseSttResponse/getBaseUrl/getAuthHeader.
 *
 * Composition (not inheritance) with Semaphore + CircuitBreakerManager
 * mirrors BaseApiConnector and avoids reaching into chat-shaped
 * ConnectorResponse from the STT layer.
 *
 * Failure classification rule (per developer.md «Resilience-pattern
 * defaults»): 4xx — application-layer faults — are NOT counted as CB
 * failures, EXCEPT 408 (timeout) and 429 (rate-limit). 5xx + network +
 * timeout DO count. 401/403/404/413 propagate to caller but leave CB
 * stats clean.
 */
export abstract class BaseSttConnector implements ISttConnector {
  abstract readonly name: string;
  abstract readonly provider: string;

  protected activeJobs = 0;
  private _semaphore?: Semaphore;
  private _cbManager?: CircuitBreakerManager;

  protected abstract getBaseUrl(): string;
  protected abstract getRequestPath(request: SttConnectorRequest): string;
  protected abstract getAuthHeader(): Record<string, string>;
  protected abstract parseSttResponse(
    json: unknown,
    request: SttConnectorRequest,
  ): {
    transcription: string;
    detectedLanguage?: string;
    audioDurationSeconds?: number;
    model: string;
    providerRequestId?: string;
  };
  protected abstract getCostUsd(audioDurationSeconds: number | undefined): number;

  /**
   * Builds the outbound HTTP request body. Default impl returns a multipart
   * `FormData` produced by `buildMultipartBody()`; raw-body providers
   * (Deepgram, AssemblyAI upload step) override this and return a
   * `{ body: Buffer, contentType: '...' }` tuple.
   */
  protected buildRequestBody(request: SttConnectorRequest): {
    body: BodyInit;
    contentType?: string;
  } {
    return { body: this.buildMultipartBody(request) };
  }

  /** Provided for FormData-style providers (Groq, OpenAI). Override either
   * this OR `buildRequestBody` — not both. */
  protected buildMultipartBody(_request: SttConnectorRequest): FormData {
    throw new Error(
      `${this.name}: must override either buildMultipartBody() or buildRequestBody()`,
    );
  }

  protected getDefaultTimeoutMs(): number {
    return 60_000;
  }

  protected getMaxConcurrency(): number {
    return 10;
  }

  protected get semaphore(): Semaphore {
    if (!this._semaphore) {
      this._semaphore = new Semaphore(this.getMaxConcurrency());
    }
    return this._semaphore;
  }

  /** @internal Testing only — override concurrency cap. */
  setSemaphore(max: number): void {
    this._semaphore = new Semaphore(max);
  }

  protected get cbManager(): CircuitBreakerManager {
    if (!this._cbManager) {
      try {
        const config = getConfig();
        this._cbManager = new CircuitBreakerManager(
          this.name,
          config.CIRCUIT_BREAKER_THRESHOLD,
          config.CIRCUIT_BREAKER_COOLDOWN_MS,
        );
      } catch {
        this._cbManager = new CircuitBreakerManager(this.name, 5, 30_000);
      }
    }
    return this._cbManager;
  }

  protected getQueueTimeoutMs(): number {
    try {
      return getConfig().CONNECTOR_QUEUE_TIMEOUT_MS;
    } catch {
      return 60_000;
    }
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

    const timeout = request.timeoutMs ?? this.getDefaultTimeoutMs();
    const start = Date.now();
    this.activeJobs++;

    try {
      const url = `${this.getBaseUrl()}${this.getRequestPath(request)}`;
      const { body, contentType } = this.buildRequestBody(request);
      const headers: Record<string, string> = {
        ...this.getAuthHeader(),
        // FormData→fetch encodes the boundary itself, so we omit Content-Type
        // unless the subclass explicitly supplies one (raw-body providers).
        ...(contentType ? { 'Content-Type': contentType } : {}),
      };

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
      });

      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const text = await res.text();
        const errType = this.classifyHttpError(res.status, text);
        if (this.shouldCountTowardCircuitBreaker(res.status, errType)) {
          cb.recordFailure(errType);
        }
        const upstreamCode = this.extractUpstreamCode(text);
        throw new SttProviderError(
          this.provider,
          errType,
          `${this.provider} responded ${res.status}: ${text.slice(0, 200)}`,
          upstreamCode,
          res.status,
        );
      }

      const json = await res.json();
      const parsed = this.parseSttResponse(json, request);
      cb.recordSuccess();

      return {
        transcription: parsed.transcription,
        detectedLanguage: parsed.detectedLanguage,
        audioDurationSeconds: parsed.audioDurationSeconds,
        model: parsed.model,
        costUsd: this.getCostUsd(parsed.audioDurationSeconds),
        latencyMs,
        providerRequestId: parsed.providerRequestId,
      };
    } catch (err) {
      if (err instanceof SttProviderError) {
        throw err;
      }
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      const message = err instanceof Error ? err.message : String(err);
      const errType: SttProviderErrorType = isAbort
        ? 'timeout'
        : message.includes('SyntaxError') || message.includes('Unexpected')
          ? 'parse_error'
          : 'network_error';
      cb.recordFailure(errType);
      throw new SttProviderError(this.provider, errType, message);
    } finally {
      this.activeJobs--;
      this.semaphore.release();
    }
  }

  async getStatus(): Promise<SttConnectorStatus> {
    const { aggregate } = this.cbManager.getStates();
    try {
      const res = await fetch(`${this.getBaseUrl()}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      return {
        name: this.name,
        healthy: res.ok && aggregate.state !== 'open',
        activeJobs: this.activeJobs,
        queuedJobs: this.semaphore.pending,
        circuitBreaker: aggregate,
      };
    } catch {
      return {
        name: this.name,
        healthy: false,
        activeJobs: this.activeJobs,
        queuedJobs: this.semaphore.pending,
        circuitBreaker: aggregate,
      };
    }
  }

  protected classifyHttpError(status: number, _body: string): SttProviderErrorType {
    if (status === 429) return 'rate_limited';
    if (status === 408) return 'timeout';
    if (status === 401 || status === 403) return 'auth_failed';
    if (status >= 500) return 'server_error';
    return 'http_error';
  }

  /**
   * 4xx (client-side mistakes: auth/payload/route) NOT counted toward CB,
   * with the exception of 408 (timeout) and 429 (rate-limit) which signal
   * downstream pressure and SHOULD trip the breaker.
   * 5xx and network/abort errors ARE counted.
   */
  protected shouldCountTowardCircuitBreaker(status: number, _errType: string): boolean {
    if (status >= 500) return true;
    if (status === 429 || status === 408) return true;
    return false;
  }

  protected extractUpstreamCode(body: string): string | undefined {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string } };
      return parsed.error?.code;
    } catch {
      return undefined;
    }
  }
}

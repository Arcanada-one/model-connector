import { randomUUID } from 'crypto';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
  IConnector,
  classifyErrorAction,
} from './interfaces/connector.interface';
import { Semaphore, QueueTimeoutError } from './base-cli.connector';
import { getConfig } from '../config/env.schema';
import { CircuitOpenError } from '../core/resilience/circuit-breaker';
import { CircuitBreakerManager } from '../core/resilience/circuit-breaker-manager';

export interface ParsedApiOutput {
  text: string;
  structured?: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  isError: boolean;
  errorMessage?: string;
}

export abstract class BaseApiConnector implements IConnector {
  readonly type = 'api' as const;
  abstract readonly name: string;

  protected activeJobs = 0;
  private _semaphore?: Semaphore;
  private _cbManager?: CircuitBreakerManager;

  protected get semaphore(): Semaphore {
    if (!this._semaphore) {
      try {
        const config = getConfig();
        const envKey =
          `${this.name.toUpperCase().replace(/-/g, '_')}_MAX_CONCURRENCY` as keyof typeof config;
        const limit = (config[envKey] as number | undefined) ?? config.CONNECTOR_MAX_CONCURRENCY;
        this._semaphore = new Semaphore(limit);
      } catch {
        this._semaphore = new Semaphore(4);
      }
    }
    return this._semaphore;
  }

  /** @internal For testing only */
  setSemaphore(max: number): void {
    this._semaphore = new Semaphore(max);
  }

  protected getQueueTimeout(): number {
    try {
      return getConfig().CONNECTOR_QUEUE_TIMEOUT_MS;
    } catch {
      return 60_000;
    }
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

  protected abstract getBaseUrl(): string;
  protected abstract buildRequestUrl(request: ConnectorRequest): string;
  protected abstract buildRequestBody(request: ConnectorRequest): unknown;
  protected abstract parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput;
  abstract getCapabilities(): ConnectorCapabilities;

  protected getTimeout(): number {
    return 30_000;
  }

  protected getHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const id = randomUUID();

    // Circuit breaker check (per-model)
    const modelCb = this.cbManager.getCircuitBreaker(request.model ?? '');
    try {
      modelCb.check();
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        const action = classifyErrorAction('circuit_open');
        return {
          id,
          connector: this.name,
          model: request.model || 'unknown',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 0,
          queueWaitMs: 0,
          status: 'error',
          error: {
            type: 'circuit_open',
            message: err.message,
            retryAfter: Math.max(0, err.nextRetryAt - Date.now()),
            ...action,
          },
        };
      }
      throw err;
    }

    const queueStart = Date.now();

    try {
      await this.semaphore.acquire(this.getQueueTimeout());
    } catch (err) {
      if (err instanceof QueueTimeoutError) {
        const action = classifyErrorAction('queue_timeout');
        return {
          id,
          connector: this.name,
          model: request.model || 'unknown',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: Date.now() - queueStart,
          queueWaitMs: Date.now() - queueStart,
          status: 'error',
          error: { type: 'queue_timeout', message: err.message, ...action },
        };
      }
      throw err;
    }

    const queueWaitMs = Date.now() - queueStart;
    const timeout = request.timeout ?? this.getTimeout();
    const start = Date.now();

    this.activeJobs++;
    try {
      const url = this.buildRequestUrl(request);
      const body = this.buildRequestBody(request);

      const res = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });

      if (!res.ok) {
        const text = await res.text();
        const errorType = this.classifyHttpError(res.status, text);
        const action = classifyErrorAction(errorType);
        modelCb.recordFailure(errorType);
        return {
          id,
          connector: this.name,
          model: request.model || 'unknown',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: Date.now() - start,
          queueWaitMs,
          status: errorType === 'rate_limited' ? 'rate_limited' : 'error',
          error: { type: errorType, message: text.slice(0, 500), ...action },
        };
      }

      const json = await res.json();
      const parsed = this.parseResponse(json, request);

      const base: ConnectorResponse = {
        id,
        connector: this.name,
        model: parsed.model || request.model || 'unknown',
        result: parsed.text,
        structured: parsed.structured,
        usage: {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          totalTokens: parsed.inputTokens + parsed.outputTokens,
          costUsd: parsed.costUsd,
        },
        latencyMs: Date.now() - start,
        queueWaitMs,
        status: parsed.isError ? 'error' : 'success',
      };

      if (parsed.isError) {
        const action = classifyErrorAction('api_error');
        base.error = {
          type: 'api_error',
          message: parsed.errorMessage || 'Unknown API error',
          ...action,
        };
        modelCb.recordFailure('api_error');
      } else {
        modelCb.recordSuccess();
      }

      return base;
    } catch (err) {
      const latencyMs = Date.now() - start;
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      const message = err instanceof Error ? err.message : String(err);
      const errorType = isAbort
        ? 'timeout'
        : message.includes('SyntaxError') || message.includes('Unexpected')
          ? 'parse_error'
          : 'network_error';
      const action = classifyErrorAction(errorType);

      modelCb.recordFailure(errorType);
      return {
        id,
        connector: this.name,
        model: request.model || 'unknown',
        result: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        latencyMs,
        queueWaitMs,
        status: isAbort ? 'timeout' : 'error',
        error: { type: errorType, message, ...action },
      };
    } finally {
      this.activeJobs--;
      this.semaphore.release();
    }
  }

  async getStatus(): Promise<ConnectorStatus> {
    const { aggregate, perModel } = this.cbManager.getStates();
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
        rateLimitStatus: 'ok',
        circuitBreaker: aggregate,
        circuitBreakers: perModel,
      };
    } catch {
      return {
        name: this.name,
        healthy: false,
        activeJobs: this.activeJobs,
        queuedJobs: this.semaphore.pending,
        rateLimitStatus: 'ok',
        circuitBreaker: aggregate,
        circuitBreakers: perModel,
      };
    }
  }

  protected classifyHttpError(status: number, _body: string): string {
    if (status === 429) return 'rate_limited';
    if (status === 401 || status === 403) return 'auth_error';
    if (status === 400 || status === 422) return 'validation_error';
    if (status >= 500) return 'server_error';
    return 'http_error';
  }
}

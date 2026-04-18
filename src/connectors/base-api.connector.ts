import { randomUUID } from 'crypto';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
  IConnector,
} from './interfaces/connector.interface';

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
        return {
          id,
          connector: this.name,
          model: request.model || 'unknown',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: Date.now() - start,
          status: errorType === 'rate_limited' ? 'rate_limited' : 'error',
          error: { type: errorType, message: text.slice(0, 500) },
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
        status: parsed.isError ? 'error' : 'success',
      };

      if (parsed.isError) {
        base.error = { type: 'api_error', message: parsed.errorMessage || 'Unknown API error' };
      }

      return base;
    } catch (err) {
      const latencyMs = Date.now() - start;
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      const message = err instanceof Error ? err.message : String(err);

      return {
        id,
        connector: this.name,
        model: request.model || 'unknown',
        result: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        latencyMs,
        status: isAbort ? 'timeout' : 'error',
        error: {
          type: isAbort ? 'timeout' : message.includes('SyntaxError') || message.includes('Unexpected')
            ? 'parse_error'
            : 'network_error',
          message,
        },
      };
    } finally {
      this.activeJobs--;
    }
  }

  async getStatus(): Promise<ConnectorStatus> {
    try {
      const res = await fetch(`${this.getBaseUrl()}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });

      return {
        name: this.name,
        healthy: res.ok,
        activeJobs: this.activeJobs,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      };
    } catch {
      return {
        name: this.name,
        healthy: false,
        activeJobs: this.activeJobs,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
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

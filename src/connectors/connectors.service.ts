import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  CircuitBreakerResetEntry,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
  IConnector,
  classifyErrorAction,
} from './interfaces/connector.interface';
import { ConnectorJobData } from '../queue/connector-job.processor';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCliConnector } from './base-cli.connector';
import { sanitizeJsonResponse, JsonSanitizeError } from '../core/utils/json-sanitizer';
import { getConfig } from '../config/env.schema';
import { MetricsService } from '../metrics/metrics.service';
import { OutputGuardMiddleware } from './output-guard/output-guard.middleware';
import type { OutputGuardReport } from './output-guard/types';

// CONN-0089: callers may pass guard-only fields alongside the base request.
export type ServiceExecuteRequest = ConnectorRequest & {
  output_format?: 'json' | 'yaml' | 'toml' | 'python' | 'auto';
  schema?: Record<string, unknown>;
};

const RETRYABLE_ERRORS = new Set([
  'json_parse_error',
  'rate_limited',
  'timeout',
  'server_error',
  'execution_error',
  'network_error',
  'spawn_error',
  'parse_error',
  'http_error',
  'api_error',
  'structured_output_error',
]);

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);
  private connectors = new Map<string, IConnector>();

  constructor(
    @InjectQueue('connector-jobs') private readonly jobQueue: Queue,
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly outputGuardMiddleware: OutputGuardMiddleware,
  ) {}

  register(connector: IConnector) {
    this.connectors.set(connector.name, connector);
    this.logger.log(`Registered connector: ${connector.name} (${connector.type})`);
  }

  get(name: string): IConnector {
    const connector = this.connectors.get(name);
    if (!connector) {
      throw new NotFoundException(`Connector "${name}" not found`);
    }
    return connector;
  }

  listNames(): string[] {
    return Array.from(this.connectors.keys());
  }

  async listAll(): Promise<
    Array<{ name: string; type: string; capabilities: ReturnType<IConnector['getCapabilities']> }>
  > {
    return Array.from(this.connectors.values()).map((c) => ({
      name: c.name,
      type: c.type,
      capabilities: c.getCapabilities(),
    }));
  }

  async getStatus(name: string): Promise<ConnectorStatus> {
    return this.get(name).getStatus();
  }

  resetCircuitBreaker(connectorName?: string, model?: string): CircuitBreakerResetEntry[] {
    if (connectorName) {
      return this.get(connectorName).resetCircuitBreaker(model);
    }
    const results: CircuitBreakerResetEntry[] = [];
    for (const connector of this.connectors.values()) {
      results.push(...connector.resetCircuitBreaker(model));
    }
    return results;
  }

  async execute(
    connectorName: string,
    request: ServiceExecuteRequest,
    apiKeyId: string,
  ): Promise<ConnectorResponse> {
    const connector = this.get(connectorName);
    let maxRetries: number;
    try {
      maxRetries = getConfig().CONNECTOR_MAX_RETRIES;
    } catch {
      maxRetries = 1;
    }
    const totalAttempts = Math.max(1, maxRetries + 1);
    const guardActive = Boolean(request.output_format);

    let lastResponse: ConnectorResponse | undefined;
    let guardReport: OutputGuardReport | null = null;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      let response: ConnectorResponse;
      if (guardActive) {
        const outcome = await this.outputGuardMiddleware.wrapExecute(connector, request);
        response = outcome.response;
        if (outcome.report) {
          guardReport = outcome.report;
        }
      } else {
        response = await connector.execute(request);
      }

      // JSON sanitization if responseFormat requested (legacy path).
      if (
        !guardActive &&
        request.responseFormat?.type === 'json_object' &&
        response.status === 'success'
      ) {
        response = this.applySanitization(response);
      }

      response.attempt = attempt;
      response.maxAttempts = totalAttempts;
      lastResponse = response;

      // Success — done
      if (response.status === 'success') {
        break;
      }

      // Non-retryable error or last attempt — done.
      // `guard_exhausted` is intentionally NOT in RETRYABLE_ERRORS — the
      // middleware already consumed its retry budget.
      const errorType = response.error?.type ?? '';
      if (!RETRYABLE_ERRORS.has(errorType) || attempt >= totalAttempts) {
        break;
      }

      // Retry with exponential backoff + jitter
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      const jitter = Math.random() * delay * 0.3;
      this.logger.warn(`Retry ${attempt}/${maxRetries} for ${connectorName}: ${errorType}`);
      await new Promise((r) => setTimeout(r, delay + jitter));
    }

    const response = lastResponse!;
    if (guardReport) {
      response.repair_report = guardReport;
    }

    // Metrics recording (per-model)
    this.metricsService.record({
      connector: connectorName,
      model: response.model,
      status: response.status,
      errorType: response.error?.type,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.costUsd,
      latencyMs: response.latencyMs,
      queueWaitMs: response.queueWaitMs,
      attempt: response.attempt,
      outputGuard: guardReport
        ? {
            retries: guardReport.retries,
            finalValid: guardReport.final_valid,
            pass: guardReport.pass,
            strategiesApplied: guardReport.strategies_applied,
          }
        : undefined,
    });

    // Fire-and-forget DB logging
    this.logRequest(response, request, apiKeyId, guardReport).catch((err) =>
      this.logger.error(`Failed to log request: ${err}`),
    );

    return response;
  }

  private applySanitization(response: ConnectorResponse): ConnectorResponse {
    try {
      const result = sanitizeJsonResponse(response.result);
      return {
        ...response,
        result: result.sanitized,
        structured: result.json,
      };
    } catch (err) {
      const action = classifyErrorAction('json_parse_error');
      return {
        ...response,
        status: 'error',
        error: {
          type: 'json_parse_error',
          message: err instanceof JsonSanitizeError ? err.message : 'Failed to parse JSON response',
          ...action,
        },
      };
    }
  }

  async enqueue(
    connectorName: string,
    request: ConnectorRequest,
    apiKeyId: string,
  ): Promise<string> {
    this.get(connectorName); // validate exists
    const job = await this.jobQueue.add('execute', {
      connectorName,
      request,
      apiKeyId,
    } satisfies ConnectorJobData);
    return job.id!;
  }

  private async logRequest(
    response: ConnectorResponse,
    request: ConnectorRequest,
    apiKeyId: string,
    repairReport: OutputGuardReport | null = null,
  ) {
    const digest = BaseCliConnector.promptDigest(request.prompt);
    await this.prisma.request.create({
      data: {
        connector: response.connector,
        model: response.model,
        promptHash: digest.promptHash,
        promptLength: digest.promptLength,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
        costUsd: response.usage.costUsd,
        latencyMs: response.latencyMs,
        status: response.status,
        errorType: response.error?.type,
        errorMessage: response.error?.message?.slice(0, 500),
        apiKeyId,
        repairReport: repairReport ? (repairReport as unknown as object) : undefined,
      },
    });
  }
}

import { randomUUID } from 'node:crypto';
import {
  type CircuitBreakerResetEntry,
  type ConnectorCapabilities,
  type ConnectorRequest,
  type ConnectorResponse,
  type ConnectorStatus,
  type IConnector,
  classifyErrorAction,
} from '../interfaces/connector.interface';

const HOSTED_EMBED_MODEL = 'nvidia/nemotron-3-embed-1b';
const HOSTED_RERANK_MODEL = 'nvidia/llama-nemotron-rerank-1b-v2';
const HOSTED_EMBED_URL = 'https://integrate.api.nvidia.com/v1/embeddings';
const HOSTED_RERANK_URLS: Readonly<Record<string, string>> = Object.freeze({
  [HOSTED_RERANK_MODEL]:
    'https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-nemotron-rerank-1b-v2/reranking',
});

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_EMBED_INPUTS = 128;
const MAX_TEXT_LENGTH = 16_000_000;
const MAX_ERROR_LENGTH = 500;
const MAX_SECRET_LENGTH = 16_384;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_CUSTOM_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  '__proto__',
  'constructor',
  'prototype',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type NvidiaSelfHostedAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'header'; name: string; value: string };

export type NvidiaRetrievalDeployment =
  | { mode: 'hosted'; apiKey: string }
  | { mode: 'self-hosted'; baseUrl: string; auth: NvidiaSelfHostedAuth };

export interface NvidiaRetrievalConfig {
  deployment: NvidiaRetrievalDeployment;
  embeddingModel: string;
  rerankModel: string;
  timeoutMs?: number;
}

export interface NvidiaRetrievalTransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface NvidiaRetrievalTransportResponse {
  status: number;
  body?: unknown;
}

export interface NvidiaRetrievalTransport {
  send(request: NvidiaRetrievalTransportRequest): Promise<NvidiaRetrievalTransportResponse>;
}

export interface NvidiaRetrievalDiscovery {
  source: 'configured' | 'runtime';
  models: string[];
  error?: string;
}

export type NvidiaRetrievalDeploymentInfo =
  | {
      mode: 'hosted';
      authentication: 'nvidia-bearer';
      discovery: 'configured-only';
      health: 'unavailable';
      geography: 'model-pages-global-not-universal';
      lifecycle: 'provider-release-notes-no-universal-sla';
      maxRerankPassages: 1000;
    }
  | {
      mode: 'self-hosted';
      authentication: 'none' | 'bearer' | 'header';
      discovery: '/v1/models';
      health: '/v1/health/ready';
      geography: 'operator-controlled';
      lifecycle: 'operator-runtime-and-provider-release-notes';
      maxRerankPassages: 512;
    };

type RetrievalOperation = 'embeddings' | 'rerank';
type EmbeddingEncoding = 'float' | 'base64';

interface ValidatedEmbeddingRequest {
  operation: 'embeddings';
  model: string;
  input: string | string[];
  inputCount: number;
  inputType: 'query' | 'passage';
  encodingFormat?: EmbeddingEncoding;
  truncate?: 'NONE' | 'START' | 'END';
  timeoutMs: number;
}

interface ValidatedRerankRequest {
  operation: 'rerank';
  model: string;
  query: string;
  passages: string[];
  truncate?: 'NONE' | 'END';
  timeoutMs: number;
}

type ValidatedRequest = ValidatedEmbeddingRequest | ValidatedRerankRequest;

interface ParsedUsage {
  prompt_tokens?: number;
  total_tokens?: number;
}

export class NvidiaRetrievalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NvidiaRetrievalConfigurationError';
  }
}

/**
 * AU-030 NVIDIA retrieval contract.
 *
 * Hosted and self-hosted NIMs share validated retrieval semantics only. Their
 * routes, auth, passage limits, discovery, readiness, and availability facts
 * remain explicitly deployment-specific. I/O is injected so this connector
 * cannot make a provider call without a caller-owned transport boundary.
 */
export class NvidiaRetrievalConnector implements IConnector {
  readonly name = 'nvidia-retrieval';
  readonly type = 'api' as const;

  private readonly deployment: NvidiaRetrievalDeployment;
  private readonly selfHostedBaseUrl?: URL;
  private readonly embeddingModel: string;
  private readonly rerankModel: string;
  private readonly timeoutMs: number;
  private activeJobs = 0;

  constructor(
    config: NvidiaRetrievalConfig,
    private readonly transport: NvidiaRetrievalTransport,
  ) {
    if (!transport || typeof transport.send !== 'function') {
      throw new NvidiaRetrievalConfigurationError(
        'An injected NVIDIA retrieval transport is required',
      );
    }
    if (!config || !NvidiaRetrievalConnector.isRecord(config)) {
      throw new NvidiaRetrievalConfigurationError('NVIDIA retrieval configuration is required');
    }

    this.deployment = NvidiaRetrievalConnector.validateDeployment(config.deployment);
    this.embeddingModel = NvidiaRetrievalConnector.validateModel(
      config.embeddingModel,
      'embeddingModel',
    );
    this.rerankModel = NvidiaRetrievalConnector.validateModel(config.rerankModel, 'rerankModel');
    this.timeoutMs = NvidiaRetrievalConnector.validateTimeout(config.timeoutMs);

    if (this.deployment.mode === 'hosted') {
      if (this.embeddingModel !== HOSTED_EMBED_MODEL) {
        throw new NvidiaRetrievalConfigurationError(
          `Hosted NVIDIA embedding model must be ${HOSTED_EMBED_MODEL}`,
        );
      }
      if (!Object.hasOwn(HOSTED_RERANK_URLS, this.rerankModel)) {
        throw new NvidiaRetrievalConfigurationError(
          'Hosted NVIDIA rerank model has no researched exact route',
        );
      }
    } else {
      this.selfHostedBaseUrl = NvidiaRetrievalConnector.validateBaseUrl(
        this.deployment.baseUrl,
      );
    }
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const validated = this.validateRequest(request);
    if (typeof validated === 'string') {
      return this.errorResponse(
        this.requestModel(request),
        'validation_error',
        validated,
      );
    }

    const startedAt = Date.now();
    this.activeJobs++;
    try {
      const response = await this.transport.send({
        method: 'POST',
        url: this.operationUrl(validated.operation, validated.model),
        headers: this.headers(),
        body: this.requestBody(validated),
        timeoutMs: validated.timeoutMs,
      });

      if (!NvidiaRetrievalConnector.isHttpStatus(response.status)) {
        return this.errorResponse(
          validated.model,
          'network_error',
          'NVIDIA retrieval transport returned an invalid HTTP status',
          startedAt,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        const type = NvidiaRetrievalConnector.classifyHttpError(response.status);
        return this.errorResponse(
          validated.model,
          type,
          this.safeProviderMessage(response.body),
          startedAt,
          type === 'timeout'
            ? 'timeout'
            : type === 'rate_limited'
              ? 'rate_limited'
              : 'error',
        );
      }

      return validated.operation === 'embeddings'
        ? this.parseEmbeddingResponse(response.body, validated, startedAt)
        : this.parseRerankResponse(response.body, validated, startedAt);
    } catch (error) {
      const timeout = NvidiaRetrievalConnector.isAbortError(error);
      return this.errorResponse(
        validated.model,
        timeout ? 'timeout' : 'network_error',
        timeout
          ? 'NVIDIA retrieval transport timed out'
          : 'NVIDIA retrieval transport failed',
        startedAt,
        timeout ? 'timeout' : 'error',
      );
    } finally {
      this.activeJobs--;
    }
  }

  async discoverModels(): Promise<NvidiaRetrievalDiscovery> {
    const configured = [this.embeddingModel, this.rerankModel];
    if (this.deployment.mode === 'hosted') {
      return { source: 'configured', models: configured };
    }

    try {
      const response = await this.transport.send({
        method: 'GET',
        url: this.selfHostedUrl('/v1/models'),
        headers: this.headers(),
        timeoutMs: this.timeoutMs,
      });
      if (
        !NvidiaRetrievalConnector.isHttpStatus(response.status) ||
        response.status < 200 ||
        response.status >= 300
      ) {
        return {
          source: 'runtime',
          models: configured,
          error: `NVIDIA retrieval model discovery returned HTTP ${
            NvidiaRetrievalConnector.isHttpStatus(response.status) ? response.status : 'invalid'
          }`,
        };
      }
      const models = NvidiaRetrievalConnector.parseModels(response.body);
      if (!models) {
        return {
          source: 'runtime',
          models: configured,
          error: 'NVIDIA retrieval model discovery returned a malformed payload',
        };
      }
      return { source: 'runtime', models };
    } catch {
      return {
        source: 'runtime',
        models: configured,
        error: 'NVIDIA retrieval model discovery failed',
      };
    }
  }

  async getStatus(): Promise<ConnectorStatus> {
    if (this.deployment.mode === 'hosted') {
      return {
        name: this.name,
        healthy: false,
        activeJobs: this.activeJobs,
        queuedJobs: 0,
        rateLimitStatus: 'ok',
      };
    }

    let healthy = false;
    try {
      const response = await this.transport.send({
        method: 'GET',
        url: this.selfHostedUrl('/v1/health/ready'),
        headers: this.headers(),
        timeoutMs: this.timeoutMs,
      });
      healthy = response.status === 200;
    } catch {
      healthy = false;
    }
    return {
      name: this.name,
      healthy,
      activeJobs: this.activeJobs,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: this.type,
      models: [this.embeddingModel, this.rerankModel],
      modelMeta: [
        { id: this.embeddingModel, modality: 'embedding' },
        { id: this.rerankModel, modality: 'rerank' },
      ],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: MAX_TIMEOUT_MS,
    };
  }

  getDeploymentInfo(): NvidiaRetrievalDeploymentInfo {
    if (this.deployment.mode === 'hosted') {
      return {
        mode: 'hosted',
        authentication: 'nvidia-bearer',
        discovery: 'configured-only',
        health: 'unavailable',
        geography: 'model-pages-global-not-universal',
        lifecycle: 'provider-release-notes-no-universal-sla',
        maxRerankPassages: 1000,
      };
    }
    return {
      mode: 'self-hosted',
      authentication: this.deployment.auth.type,
      discovery: '/v1/models',
      health: '/v1/health/ready',
      geography: 'operator-controlled',
      lifecycle: 'operator-runtime-and-provider-release-notes',
      maxRerankPassages: 512,
    };
  }

  resetCircuitBreaker(_model?: string): CircuitBreakerResetEntry[] {
    return [];
  }

  private validateRequest(request: ConnectorRequest): ValidatedRequest | string {
    if (!request || !NvidiaRetrievalConnector.isRecord(request)) {
      return 'NVIDIA retrieval request must be an object';
    }
    const extra = request.extra;
    if (!extra || !NvidiaRetrievalConnector.isRecord(extra)) {
      return 'NVIDIA retrieval operation must be explicit';
    }
    const operation = NvidiaRetrievalConnector.dataProperty(extra, 'operation');
    if (operation !== 'embeddings' && operation !== 'rerank') {
      return "NVIDIA retrieval operation must be 'embeddings' or 'rerank'";
    }

    const timeout = request.timeout ?? this.timeoutMs;
    if (!NvidiaRetrievalConnector.isValidTimeout(timeout)) {
      return `NVIDIA retrieval timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms`;
    }
    if (operation === 'embeddings') return this.validateEmbeddingRequest(request, extra, timeout);
    return this.validateRerankRequest(request, extra, timeout);
  }

  private validateEmbeddingRequest(
    request: ConnectorRequest,
    extra: Record<string, unknown>,
    timeoutMs: number,
  ): ValidatedEmbeddingRequest | string {
    const model = this.embeddingModel;
    if (request.model !== undefined && request.model !== model) {
      return `NVIDIA embedding request model must match configured model '${model}'`;
    }

    const explicitInput = NvidiaRetrievalConnector.dataProperty(extra, 'input');
    const input = explicitInput === undefined ? request.prompt : explicitInput;
    if (!NvidiaRetrievalConnector.isTextInput(input)) {
      return `NVIDIA embeddings input must be a non-empty string or 1-${MAX_EMBED_INPUTS} non-empty strings`;
    }
    const inputType = NvidiaRetrievalConnector.dataProperty(extra, 'inputType');
    if (inputType !== 'query' && inputType !== 'passage') {
      return "NVIDIA embeddings inputType must be 'query' or 'passage'";
    }

    const encodingFormat = NvidiaRetrievalConnector.dataProperty(extra, 'encodingFormat');
    if (
      encodingFormat !== undefined &&
      encodingFormat !== 'float' &&
      encodingFormat !== 'base64'
    ) {
      return "NVIDIA embeddings encodingFormat must be 'float' or 'base64'";
    }
    const truncate = NvidiaRetrievalConnector.dataProperty(extra, 'truncate');
    if (
      truncate !== undefined &&
      truncate !== 'NONE' &&
      truncate !== 'START' &&
      truncate !== 'END'
    ) {
      return "NVIDIA embeddings truncate must be 'NONE', 'START', or 'END'";
    }

    return {
      operation: 'embeddings',
      model,
      input: typeof input === 'string' ? input : [...input],
      inputCount: typeof input === 'string' ? 1 : input.length,
      inputType,
      encodingFormat,
      truncate,
      timeoutMs,
    };
  }

  private validateRerankRequest(
    request: ConnectorRequest,
    extra: Record<string, unknown>,
    timeoutMs: number,
  ): ValidatedRerankRequest | string {
    const model = this.rerankModel;
    if (request.model !== undefined && request.model !== model) {
      return `NVIDIA rerank request model must match configured model '${model}'`;
    }
    if (!NvidiaRetrievalConnector.isText(request.prompt)) {
      return 'NVIDIA rerank query must be a non-empty string';
    }

    const passages = NvidiaRetrievalConnector.dataProperty(extra, 'passages');
    const maxPassages = this.deployment.mode === 'hosted' ? 1000 : 512;
    if (
      !Array.isArray(passages) ||
      passages.length === 0 ||
      passages.length > maxPassages ||
      !passages.every(NvidiaRetrievalConnector.isText)
    ) {
      return `NVIDIA rerank passages must contain 1-${maxPassages} non-empty strings`;
    }
    const truncate = NvidiaRetrievalConnector.dataProperty(extra, 'truncate');
    if (truncate !== undefined && truncate !== 'NONE' && truncate !== 'END') {
      return "NVIDIA rerank truncate must be 'NONE' or 'END'";
    }

    return {
      operation: 'rerank',
      model,
      query: request.prompt,
      passages: [...passages],
      truncate,
      timeoutMs,
    };
  }

  private operationUrl(operation: RetrievalOperation, model: string): string {
    if (this.deployment.mode === 'self-hosted') {
      return this.selfHostedUrl(operation === 'embeddings' ? '/v1/embeddings' : '/v1/ranking');
    }
    if (operation === 'embeddings') return HOSTED_EMBED_URL;
    const exactUrl = HOSTED_RERANK_URLS[model];
    if (!exactUrl) {
      throw new NvidiaRetrievalConfigurationError(
        'Hosted NVIDIA rerank model has no researched exact route',
      );
    }
    return exactUrl;
  }

  private selfHostedUrl(path: string): string {
    if (!this.selfHostedBaseUrl) {
      throw new NvidiaRetrievalConfigurationError('Self-hosted NVIDIA base URL is unavailable');
    }
    const url = new URL(this.selfHostedBaseUrl.toString());
    const prefix = url.pathname.replace(/\/+$/, '');
    url.pathname = `${prefix}${path}`;
    return url.toString();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.deployment.mode === 'hosted') {
      headers.Authorization = `Bearer ${this.deployment.apiKey}`;
    } else if (this.deployment.auth.type === 'bearer') {
      headers.Authorization = `Bearer ${this.deployment.auth.token}`;
    } else if (this.deployment.auth.type === 'header') {
      headers[this.deployment.auth.name] = this.deployment.auth.value;
    }
    return headers;
  }

  private requestBody(request: ValidatedRequest): Record<string, unknown> {
    if (request.operation === 'rerank') {
      const body: Record<string, unknown> = {
        model: request.model,
        query: { text: request.query },
        passages: request.passages.map((text) => ({ text })),
      };
      if (request.truncate !== undefined) body.truncate = request.truncate;
      return body;
    }

    const body: Record<string, unknown> = {
      model: request.model,
      input: request.input,
      input_type: request.inputType,
    };
    if (request.encodingFormat !== undefined) body.encoding_format = request.encodingFormat;
    if (request.truncate !== undefined) body.truncate = request.truncate;
    return body;
  }

  private parseEmbeddingResponse(
    body: unknown,
    request: ValidatedEmbeddingRequest,
    startedAt: number,
  ): ConnectorResponse {
    try {
      if (!NvidiaRetrievalConnector.isPlainRecord(body)) {
        return this.parseError(request.model, 'NVIDIA embedding response must be an object', startedAt);
      }
      if (
        NvidiaRetrievalConnector.dataProperty(body, 'object') !== 'list' ||
        NvidiaRetrievalConnector.dataProperty(body, 'model') !== request.model
      ) {
        return this.parseError(
          request.model,
          'NVIDIA embedding response has an invalid object or model',
          startedAt,
        );
      }
      const rawData = NvidiaRetrievalConnector.dataProperty(body, 'data');
      if (!Array.isArray(rawData) || rawData.length !== request.inputCount || rawData.length === 0) {
        return this.parseError(
          request.model,
          'NVIDIA embedding response data does not match the submitted inputs',
          startedAt,
        );
      }

      const seen = new Set<number>();
      const data: Array<{ object: 'embedding'; index: number; embedding: number[] | string }> = [];
      for (const rawEntry of rawData) {
        if (!NvidiaRetrievalConnector.isPlainRecord(rawEntry)) {
          return this.parseError(request.model, 'NVIDIA embedding entry is malformed', startedAt);
        }
        const object = NvidiaRetrievalConnector.dataProperty(rawEntry, 'object');
        const index = NvidiaRetrievalConnector.dataProperty(rawEntry, 'index');
        const embedding = NvidiaRetrievalConnector.dataProperty(rawEntry, 'embedding');
        if (
          object !== 'embedding' ||
          !Number.isInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= request.inputCount ||
          seen.has(index as number) ||
          !NvidiaRetrievalConnector.validEmbedding(embedding, request.encodingFormat ?? 'float')
        ) {
          return this.parseError(request.model, 'NVIDIA embedding entry is malformed', startedAt);
        }
        seen.add(index as number);
        data.push({
          object: 'embedding',
          index: index as number,
          embedding: Array.isArray(embedding) ? [...embedding] : (embedding as string),
        });
      }

      const usage = NvidiaRetrievalConnector.parseUsage(
        NvidiaRetrievalConnector.dataProperty(body, 'usage'),
      );
      if (usage === null) {
        return this.parseError(request.model, 'NVIDIA embedding usage is malformed', startedAt);
      }
      const structured: {
        operation: 'embeddings';
        data: typeof data;
        usage?: ParsedUsage;
      } = { operation: 'embeddings', data };
      if (usage !== undefined) structured.usage = usage;
      return this.successResponse(request.model, data, structured, usage, startedAt);
    } catch {
      return this.parseError(request.model, 'NVIDIA embedding response is malformed', startedAt);
    }
  }

  private parseRerankResponse(
    body: unknown,
    request: ValidatedRerankRequest,
    startedAt: number,
  ): ConnectorResponse {
    try {
      if (!NvidiaRetrievalConnector.isPlainRecord(body)) {
        return this.parseError(request.model, 'NVIDIA rerank response must be an object', startedAt);
      }
      const rawRankings = NvidiaRetrievalConnector.dataProperty(body, 'rankings');
      if (!Array.isArray(rawRankings) || rawRankings.length !== request.passages.length) {
        return this.parseError(
          request.model,
          'NVIDIA rerank response does not cover the submitted passages',
          startedAt,
        );
      }

      const seen = new Set<number>();
      const rankings: Array<{ index: number; logit: number }> = [];
      for (const rawRanking of rawRankings) {
        if (!NvidiaRetrievalConnector.isPlainRecord(rawRanking)) {
          return this.parseError(request.model, 'NVIDIA rerank entry is malformed', startedAt);
        }
        const index = NvidiaRetrievalConnector.dataProperty(rawRanking, 'index');
        const logit = NvidiaRetrievalConnector.dataProperty(rawRanking, 'logit');
        if (
          !Number.isInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= request.passages.length ||
          seen.has(index as number) ||
          typeof logit !== 'number' ||
          !Number.isFinite(logit)
        ) {
          return this.parseError(request.model, 'NVIDIA rerank entry is malformed', startedAt);
        }
        seen.add(index as number);
        rankings.push({ index: index as number, logit });
      }

      const usage = NvidiaRetrievalConnector.parseUsage(
        NvidiaRetrievalConnector.dataProperty(body, 'usage'),
      );
      if (usage === null) {
        return this.parseError(request.model, 'NVIDIA rerank usage is malformed', startedAt);
      }
      const structured: {
        operation: 'rerank';
        rankings: typeof rankings;
        usage?: ParsedUsage;
      } = { operation: 'rerank', rankings };
      if (usage !== undefined) structured.usage = usage;
      return this.successResponse(request.model, rankings, structured, usage, startedAt);
    } catch {
      return this.parseError(request.model, 'NVIDIA rerank response is malformed', startedAt);
    }
  }

  private successResponse(
    model: string,
    result: unknown,
    structured: unknown,
    usage: ParsedUsage | undefined,
    startedAt: number,
  ): ConnectorResponse {
    return {
      id: randomUUID(),
      connector: this.name,
      model,
      result: JSON.stringify(result),
      structured,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: 0,
        totalTokens: usage?.total_tokens ?? 0,
        costUsd: 0,
      },
      latencyMs: Math.max(0, Date.now() - startedAt),
      status: 'success',
    };
  }

  private parseError(model: string, message: string, startedAt: number): ConnectorResponse {
    return this.errorResponse(model, 'parse_error', message, startedAt);
  }

  private errorResponse(
    model: string,
    type: string,
    message: string,
    startedAt = Date.now(),
    status: ConnectorResponse['status'] = 'error',
  ): ConnectorResponse {
    return {
      id: randomUUID(),
      connector: this.name,
      model,
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: Math.max(0, Date.now() - startedAt),
      status,
      error: { type, message, ...classifyErrorAction(type) },
    };
  }

  private safeProviderMessage(body: unknown): string {
    let message = 'NVIDIA retrieval deployment returned an error';
    try {
      if (typeof body === 'string') {
        message = body;
      } else if (NvidiaRetrievalConnector.isPlainRecord(body)) {
        const direct = NvidiaRetrievalConnector.dataProperty(body, 'message');
        const error = NvidiaRetrievalConnector.dataProperty(body, 'error');
        const nested = NvidiaRetrievalConnector.isPlainRecord(error)
          ? NvidiaRetrievalConnector.dataProperty(error, 'message')
          : undefined;
        if (typeof nested === 'string') message = nested;
        else if (typeof direct === 'string') message = direct;
      }
    } catch {
      message = 'NVIDIA retrieval deployment returned an error';
    }
    const secrets = this.secrets();
    const maxSecretLength = secrets.reduce(
      (maximum, secret) => Math.max(maximum, secret.length),
      0,
    );
    message = message.slice(0, MAX_ERROR_LENGTH + maxSecretLength);
    for (const secret of secrets) {
      if (secret !== '') message = message.split(secret).join('[REDACTED]');
    }
    return message.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MAX_ERROR_LENGTH);
  }

  private secrets(): string[] {
    if (this.deployment.mode === 'hosted') return [this.deployment.apiKey];
    if (this.deployment.auth.type === 'bearer') return [this.deployment.auth.token];
    if (this.deployment.auth.type === 'header') return [this.deployment.auth.value];
    return [];
  }

  private requestModel(request: ConnectorRequest): string {
    const extra = request && NvidiaRetrievalConnector.isRecord(request.extra) ? request.extra : {};
    return NvidiaRetrievalConnector.dataProperty(extra, 'operation') === 'rerank'
      ? this.rerankModel
      : this.embeddingModel;
  }

  private static validateDeployment(value: unknown): NvidiaRetrievalDeployment {
    if (!NvidiaRetrievalConnector.isPlainRecord(value)) {
      throw new NvidiaRetrievalConfigurationError('NVIDIA deployment mode must be explicit');
    }
    const mode = NvidiaRetrievalConnector.dataProperty(value, 'mode');
    if (mode === 'hosted') {
      const apiKey = NvidiaRetrievalConnector.dataProperty(value, 'apiKey');
      if (!NvidiaRetrievalConnector.isSecret(apiKey)) {
        throw new NvidiaRetrievalConfigurationError('Hosted NVIDIA mode requires an API key');
      }
      return { mode, apiKey };
    }
    if (mode === 'self-hosted') {
      const baseUrl = NvidiaRetrievalConnector.dataProperty(value, 'baseUrl');
      const auth = NvidiaRetrievalConnector.validateAuth(
        NvidiaRetrievalConnector.dataProperty(value, 'auth'),
      );
      if (typeof baseUrl !== 'string') {
        throw new NvidiaRetrievalConfigurationError('Self-hosted NVIDIA base URL is required');
      }
      NvidiaRetrievalConnector.validateBaseUrl(baseUrl);
      return { mode, baseUrl, auth };
    }
    throw new NvidiaRetrievalConfigurationError('Unsupported NVIDIA retrieval deployment mode');
  }

  private static validateAuth(value: unknown): NvidiaSelfHostedAuth {
    if (!NvidiaRetrievalConnector.isPlainRecord(value)) {
      throw new NvidiaRetrievalConfigurationError('Self-hosted inference auth must be explicit');
    }
    const type = NvidiaRetrievalConnector.dataProperty(value, 'type');
    if (type === 'none') return { type };
    if (type === 'bearer') {
      const token = NvidiaRetrievalConnector.dataProperty(value, 'token');
      if (!NvidiaRetrievalConnector.isSecret(token)) {
        throw new NvidiaRetrievalConfigurationError('Self-hosted Bearer auth requires a token');
      }
      return { type, token };
    }
    if (type === 'header') {
      const name = NvidiaRetrievalConnector.dataProperty(value, 'name');
      const headerValue = NvidiaRetrievalConnector.dataProperty(value, 'value');
      if (
        typeof name !== 'string' ||
        !HEADER_NAME.test(name) ||
        FORBIDDEN_CUSTOM_HEADERS.has(name.toLowerCase()) ||
        !NvidiaRetrievalConnector.isSecret(headerValue)
      ) {
        throw new NvidiaRetrievalConfigurationError('Invalid self-hosted auth header');
      }
      return { type, name, value: headerValue };
    }
    throw new NvidiaRetrievalConfigurationError('Unsupported self-hosted auth mode');
  }

  private static validateBaseUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new NvidiaRetrievalConfigurationError('Self-hosted NVIDIA base URL must be absolute');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new NvidiaRetrievalConfigurationError(
        'Self-hosted NVIDIA base URL must use HTTP or HTTPS',
      );
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new NvidiaRetrievalConfigurationError(
        'Self-hosted NVIDIA base URL cannot contain credentials, query, or fragment',
      );
    }
    return url;
  }

  private static validateModel(value: unknown, field: string): string {
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new NvidiaRetrievalConfigurationError(`${field} must be a safe model identifier`);
    }
    return value;
  }

  private static validateTimeout(value: unknown): number {
    const timeout = value ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeout !== 'number' || !NvidiaRetrievalConnector.isValidTimeout(timeout)) {
      throw new NvidiaRetrievalConfigurationError(
        `NVIDIA retrieval timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms`,
      );
    }
    return timeout;
  }

  private static parseUsage(value: unknown): ParsedUsage | undefined | null {
    if (value === undefined) return undefined;
    if (!NvidiaRetrievalConnector.isPlainRecord(value)) return null;
    const prompt = NvidiaRetrievalConnector.dataProperty(value, 'prompt_tokens');
    const total = NvidiaRetrievalConnector.dataProperty(value, 'total_tokens');
    if (prompt !== undefined && !NvidiaRetrievalConnector.isTokenCount(prompt)) return null;
    if (total !== undefined && !NvidiaRetrievalConnector.isTokenCount(total)) return null;
    if (typeof prompt === 'number' && typeof total === 'number' && total < prompt) return null;
    const usage: ParsedUsage = {};
    if (typeof prompt === 'number') usage.prompt_tokens = prompt;
    if (typeof total === 'number') usage.total_tokens = total;
    return usage;
  }

  private static parseModels(body: unknown): string[] | undefined {
    try {
      if (!NvidiaRetrievalConnector.isPlainRecord(body)) return undefined;
      const data = NvidiaRetrievalConnector.dataProperty(body, 'data');
      if (!Array.isArray(data) || data.length === 0 || data.length > 10_000) return undefined;
      const models: string[] = [];
      const seen = new Set<string>();
      for (const entry of data) {
        if (!NvidiaRetrievalConnector.isPlainRecord(entry)) return undefined;
        const id = NvidiaRetrievalConnector.dataProperty(entry, 'id');
        if (
          typeof id !== 'string' ||
          id.trim() === '' ||
          id.length > 256 ||
          /[\u0000-\u001f\u007f]/.test(id)
        ) {
          return undefined;
        }
        if (!seen.has(id)) {
          seen.add(id);
          models.push(id);
        }
      }
      return models;
    } catch {
      return undefined;
    }
  }

  private static dataProperty(record: Record<string, unknown>, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  }

  private static isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    } catch {
      return false;
    }
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private static isSecret(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.trim() !== '' &&
      value.length <= MAX_SECRET_LENGTH &&
      !/[\u0000-\u001f\u007f]/.test(value)
    );
  }

  private static isText(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
  }

  private static isTextInput(value: unknown): value is string | string[] {
    return (
      NvidiaRetrievalConnector.isText(value) ||
      (Array.isArray(value) &&
        value.length > 0 &&
        value.length <= MAX_EMBED_INPUTS &&
        value.every(NvidiaRetrievalConnector.isText))
    );
  }

  private static validEmbedding(value: unknown, encoding: EmbeddingEncoding): boolean {
    if (encoding === 'base64') {
      return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(value)
      );
    }
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 65_536 &&
      value.every((part) => typeof part === 'number' && Number.isFinite(part))
    );
  }

  private static isTokenCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }

  private static isValidTimeout(value: number): boolean {
    return Number.isInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS;
  }

  private static isHttpStatus(value: number): boolean {
    return Number.isInteger(value) && value >= 100 && value <= 599;
  }

  private static classifyHttpError(status: number): string {
    if (status === 400 || status === 422) return 'validation_error';
    if (status === 401 || status === 403) return 'auth_error';
    if (status === 402) return 'billing_error';
    if (status === 404) return 'model_not_found';
    if (status === 408 || status === 504) return 'timeout';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server_error';
    return 'http_error';
  }

  private static isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }
}

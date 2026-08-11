import { randomUUID } from 'node:crypto';
import {
  CircuitBreakerResetEntry,
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
  IConnector,
  classifyErrorAction,
} from '../interfaces/connector.interface';

export interface BedrockUnsignedRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type BedrockSignedRequest = BedrockUnsignedRequest;
export type BedrockSigner = (request: BedrockUnsignedRequest) => Promise<BedrockSignedRequest>;
export type BedrockFetch = (url: string, init: RequestInit) => Promise<Response>;

export class BedrockSignerNotConfiguredError extends Error {
  constructor() {
    super('Bedrock SigV4 signer is not configured');
    this.name = 'BedrockSignerNotConfiguredError';
  }
}

export interface BedrockConfig {
  BEDROCK_REGION: string;
  BEDROCK_MODELS: string[];
}

interface BedrockResponse {
  output?: { message?: { content?: Array<{ text?: unknown }> } };
  stopReason?: unknown;
  usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown };
}

export class BedrockConnector implements IConnector {
  readonly name = 'bedrock';
  readonly type = 'api' as const;
  private activeJobs = 0;

  constructor(
    private readonly config: BedrockConfig,
    private readonly signer: BedrockSigner,
    private readonly fetchFn: BedrockFetch = (url, init) => fetch(url, init),
  ) {}

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: this.type,
      models: [...this.config.BEDROCK_MODELS],
      modelMeta: this.config.BEDROCK_MODELS.map((id) => ({ id })),
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
      modality: 'chat',
    };
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const id = randomUUID();
    const model = request.model ?? this.config.BEDROCK_MODELS[0] ?? 'unknown';
    const started = Date.now();

    if (!this.config.BEDROCK_MODELS.includes(model)) {
      return this.error(
        id,
        model,
        started,
        'model_not_found',
        `Unsupported Bedrock model: ${model}`,
      );
    }
    if (typeof request.prompt !== 'string') {
      return this.error(
        id,
        model,
        started,
        'unsupported_modality',
        'Bedrock connector currently accepts text prompts only',
      );
    }

    const payload: Record<string, unknown> = {
      messages: [{ role: 'user', content: [{ text: request.prompt }] }],
    };
    if (request.systemPrompt) payload.system = [{ text: request.systemPrompt }];
    const inferenceConfig = this.buildInferenceConfig(request.extra);
    if (Object.keys(inferenceConfig).length > 0) payload.inferenceConfig = inferenceConfig;

    const unsigned: BedrockUnsignedRequest = {
      method: 'POST',
      url: `https://bedrock-runtime.${this.config.BEDROCK_REGION}.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };

    this.activeJobs++;
    try {
      const signed = await this.signer(unsigned);
      const response = await this.fetchFn(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: signed.body,
      });
      if (!response.ok) return await this.mapAwsError(id, model, started, response);

      const json = (await response.json()) as BedrockResponse;
      const blocks = json.output?.message?.content ?? [];
      const result = blocks
        .map((block) => block.text)
        .filter((text): text is string => typeof text === 'string')
        .join('');
      const inputTokens = this.numberOrZero(json.usage?.inputTokens);
      const outputTokens = this.numberOrZero(json.usage?.outputTokens);
      const totalTokens = this.numberOrZero(json.usage?.totalTokens) || inputTokens + outputTokens;
      return {
        id,
        connector: this.name,
        model,
        result,
        structured:
          typeof json.stopReason === 'string' ? { stopReason: json.stopReason } : undefined,
        usage: { inputTokens, outputTokens, totalTokens, costUsd: 0 },
        latencyMs: Date.now() - started,
        status: 'success',
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const type =
        cause instanceof BedrockSignerNotConfiguredError
          ? 'auth_error'
          : cause instanceof SyntaxError
            ? 'parse_error'
            : 'network_error';
      return this.error(id, model, started, type, message);
    } finally {
      this.activeJobs--;
    }
  }

  async getStatus(): Promise<ConnectorStatus> {
    return {
      name: this.name,
      healthy: true,
      activeJobs: this.activeJobs,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
    };
  }

  resetCircuitBreaker(_model?: string): CircuitBreakerResetEntry[] {
    return [];
  }

  private buildInferenceConfig(
    extra: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    if (!extra) return config;
    if (typeof extra.max_tokens === 'number') config.maxTokens = extra.max_tokens;
    if (typeof extra.temperature === 'number') config.temperature = extra.temperature;
    if (typeof extra.top_p === 'number') config.topP = extra.top_p;
    if (Array.isArray(extra.stop) && extra.stop.every((value) => typeof value === 'string')) {
      config.stopSequences = extra.stop;
    }
    return config;
  }

  private async mapAwsError(
    id: string,
    model: string,
    started: number,
    response: Response,
  ): Promise<ConnectorResponse> {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // A bounded generic message is safer than forwarding an arbitrary raw body.
    }
    const rawType = [body.__type, body.code, body.type].find((value) => typeof value === 'string');
    const awsType = typeof rawType === 'string' ? (rawType.split(/[#/]/).pop() ?? '') : '';
    const message =
      typeof body.message === 'string' ? body.message : `Bedrock HTTP ${response.status}`;
    let type: string;
    if (awsType === 'ThrottlingException' || response.status === 429) type = 'rate_limited';
    else if (
      awsType === 'AccessDeniedException' ||
      response.status === 401 ||
      response.status === 403
    )
      type = 'auth_error';
    else if (awsType === 'ResourceNotFoundException' || response.status === 404)
      type = 'model_not_found';
    else if (
      awsType === 'ValidationException' ||
      response.status === 400 ||
      response.status === 422
    )
      type = 'validation_error';
    else if (awsType === 'ModelTimeoutException' || response.status === 408) type = 'timeout';
    else if (response.status >= 500) type = 'server_error';
    else type = 'http_error';
    return this.error(id, model, started, type, message);
  }

  private error(
    id: string,
    model: string,
    started: number,
    type: string,
    message: string,
  ): ConnectorResponse {
    return {
      id,
      connector: this.name,
      model,
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: Date.now() - started,
      status: type === 'rate_limited' ? 'rate_limited' : type === 'timeout' ? 'timeout' : 'error',
      error: { type, message: message.slice(0, 500), ...classifyErrorAction(type) },
    };
  }

  private numberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
}

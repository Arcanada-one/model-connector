import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  classifyErrorAction,
  type CircuitBreakerResetEntry,
  type ConnectorCapabilities,
  type ConnectorRequest,
  type ConnectorResponse,
  type ConnectorStatus,
  type IConnector,
} from '../../interfaces/connector.interface';
import {
  BEDROCK_NOVA_MEDIA_SIGNER,
  BEDROCK_NOVA_MEDIA_TRANSPORT,
  CANVAS_MODEL,
  NOVA_MEDIA_MODEL_META,
  REEL_MODELS,
  bedrockRuntimeEndpoint,
} from './nova-media.contract';
import type {
  AwsPartition,
  BedrockHttpRequest,
  BedrockSigner,
  BedrockTransport,
  CanvasInvokeCall,
  CanvasInvokeResponse,
  ReelGetCall,
  ReelInvocation,
  ReelListCall,
  ReelListResponse,
  ReelOutputArtifact,
  ReelStartCall,
  ReelStartResponse,
} from './nova-media.types';
import {
  validateCanvasCall,
  validateReelGetCall,
  validateReelInvocation,
  validateReelListCall,
  validateReelListResponse,
  validateReelOutput,
  validateReelStartCall,
  validateReelStartResponse,
} from './nova-media.validation';

class NovaMediaNotConfiguredError extends Error {}

export class NovaMediaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly providerType: string,
    message: string,
  ) {
    super(message);
    this.name = 'NovaMediaHttpError';
  }
}

@Injectable()
export class NovaMediaConnector implements IConnector {
  readonly name = 'bedrock-nova-media';
  readonly type = 'api' as const;

  constructor(
    @Optional()
    @Inject(BEDROCK_NOVA_MEDIA_SIGNER)
    private readonly signer?: BedrockSigner,
    @Optional()
    @Inject(BEDROCK_NOVA_MEDIA_TRANSPORT)
    private readonly transport?: BedrockTransport,
  ) {}

  async invokeCanvas(call: CanvasInvokeCall): Promise<CanvasInvokeResponse> {
    validateCanvasCall(call);
    const endpoint = bedrockRuntimeEndpoint(call.region, call.partition);
    const request = this.jsonRequest(
      `${endpoint}/model/${encodeURIComponent(call.modelId)}/invoke`,
      call.input,
    );
    const result = await this.send(request, call.region);
    return this.validateCanvasResponse(result);
  }

  async startReel(call: ReelStartCall): Promise<ReelStartResponse> {
    validateReelStartCall(call);
    const body = {
      ...(call.clientRequestToken ? { clientRequestToken: call.clientRequestToken } : {}),
      modelId: call.modelId,
      modelInput: call.modelInput,
      outputDataConfig: call.outputDataConfig,
      ...(call.tags ? { tags: call.tags } : {}),
    };
    const endpoint = bedrockRuntimeEndpoint(call.region, call.partition);
    const result = await this.send(this.jsonRequest(`${endpoint}/async-invoke`, body), call.region);
    return validateReelStartResponse(result, call.region);
  }

  async getReel(call: ReelGetCall): Promise<ReelInvocation> {
    validateReelGetCall(call);
    const endpoint = bedrockRuntimeEndpoint(call.region, call.partition);
    const url = `${endpoint}/async-invoke/${encodeURIComponent(call.invocationArn)}`;
    const result = await this.send(this.getRequest(url), call.region);
    return validateReelInvocation(result);
  }

  async listReel(call: ReelListCall): Promise<ReelListResponse> {
    validateReelListCall(call);
    const endpoint = bedrockRuntimeEndpoint(call.region, call.partition);
    const url = new URL(`${endpoint}/async-invoke`);
    this.addListQuery(url, call);
    const result = await this.send(this.getRequest(url.toString()), call.region);
    return validateReelListResponse(result);
  }

  parseReelOutput(value: unknown): ReelOutputArtifact {
    return validateReelOutput(value);
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const startedAt = Date.now();
    try {
      const structured = await this.executeOperation(request);
      return this.responseEnvelope(request, startedAt, structured);
    } catch (caught) {
      return this.errorEnvelope(request, startedAt, caught);
    }
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: this.type,
      models: [CANVAS_MODEL, ...REEL_MODELS],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
      modelMeta: [...NOVA_MEDIA_MODEL_META],
    };
  }

  async getStatus(): Promise<ConnectorStatus> {
    return {
      name: this.name,
      healthy: Boolean(this.signer && this.transport),
      activeJobs: 0,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
    };
  }

  resetCircuitBreaker(): CircuitBreakerResetEntry[] {
    return [];
  }

  private async executeOperation(request: ConnectorRequest): Promise<unknown> {
    const extra = request.extra ?? {};
    const operation = extra.operation;
    const partition = extra.partition as AwsPartition | undefined;
    if (operation === 'reel.output') return this.parseReelOutput(extra.output);
    const region = this.requiredString(extra.region, 'region');
    if (operation === 'canvas.invoke') {
      return this.invokeCanvas({
        partition,
        region,
        modelId: request.model as CanvasInvokeCall['modelId'],
        input: extra.input as CanvasInvokeCall['input'],
      });
    }
    if (operation === 'reel.start') {
      return this.startReel({
        ...(extra.call as ReelStartCall),
        partition,
        region,
        modelId: request.model as ReelStartCall['modelId'],
      });
    }
    if (operation === 'reel.get') {
      return this.getReel({
        partition,
        region,
        invocationArn: this.requiredString(extra.invocationArn, 'invocationArn'),
      });
    }
    if (operation === 'reel.list') {
      return this.listReel({ ...(extra.query as ReelListCall), partition, region });
    }
    throw new Error('Nova media validation: unsupported operation');
  }

  private jsonRequest(url: string, body: unknown): BedrockHttpRequest {
    return {
      method: 'POST',
      url,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  private getRequest(url: string): BedrockHttpRequest {
    return { method: 'GET', url, headers: { accept: 'application/json' } };
  }

  private async send(request: BedrockHttpRequest, region: string): Promise<unknown> {
    if (!this.signer || !this.transport) {
      throw new NovaMediaNotConfiguredError('Nova media signer and transport are not configured');
    }
    const signed = await this.signer.sign(request, { service: 'bedrock', region });
    const response = await this.transport.send(signed);
    const parsed = this.parseBody(response.body);
    if (response.status < 200 || response.status >= 300) {
      const error = this.providerError(parsed);
      throw new NovaMediaHttpError(response.status, error.type, error.message);
    }
    return parsed;
  }

  private parseBody(body: string): unknown {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new NovaMediaHttpError(502, 'InvalidProviderResponse', 'Bedrock returned invalid JSON');
    }
  }

  private providerError(value: unknown): { type: string; message: string } {
    if (!value || typeof value !== 'object') {
      return { type: 'BedrockError', message: 'Bedrock request failed' };
    }
    const record = value as Record<string, unknown>;
    return {
      type:
        typeof record.__type === 'string'
          ? record.__type.split('#').at(-1) || 'BedrockError'
          : 'BedrockError',
      message: typeof record.message === 'string' ? record.message : 'Bedrock request failed',
    };
  }

  private validateCanvasResponse(value: unknown): CanvasInvokeResponse {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new NovaMediaHttpError(
        502,
        'InvalidProviderResponse',
        'Canvas response is not an object',
      );
    }
    const response = value as Record<string, unknown>;
    if (
      response.images !== undefined &&
      (!Array.isArray(response.images) ||
        response.images.some((image) => typeof image !== 'string'))
    ) {
      throw new NovaMediaHttpError(502, 'InvalidProviderResponse', 'Canvas images are invalid');
    }
    if (response.maskImage !== undefined && typeof response.maskImage !== 'string') {
      throw new NovaMediaHttpError(502, 'InvalidProviderResponse', 'Canvas maskImage is invalid');
    }
    if (response.error !== undefined && typeof response.error !== 'string') {
      throw new NovaMediaHttpError(502, 'InvalidProviderResponse', 'Canvas error is invalid');
    }
    if (
      response.images === undefined &&
      response.maskImage === undefined &&
      response.error === undefined
    ) {
      throw new NovaMediaHttpError(
        502,
        'InvalidProviderResponse',
        'Canvas response contains no result fields',
      );
    }
    return value as CanvasInvokeResponse;
  }

  private addListQuery(url: URL, call: ReelListCall): void {
    const values: Array<[string, string | number | undefined]> = [
      ['maxResults', call.maxResults],
      ['nextToken', call.nextToken],
      ['sortBy', call.sortBy],
      ['sortOrder', call.sortOrder],
      ['statusEquals', call.statusEquals],
      ['submitTimeAfter', call.submitTimeAfter],
      ['submitTimeBefore', call.submitTimeBefore],
    ];
    for (const [key, value] of values) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  private requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Nova media validation: ${label} is required`);
    }
    return value;
  }

  private responseEnvelope(
    request: ConnectorRequest,
    startedAt: number,
    structured: unknown,
  ): ConnectorResponse {
    return {
      id: randomUUID(),
      connector: this.name,
      model: request.model ?? 'unknown',
      result: JSON.stringify(structured),
      structured,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: Date.now() - startedAt,
      queueWaitMs: 0,
      status: 'success',
    };
  }

  private errorEnvelope(
    request: ConnectorRequest,
    startedAt: number,
    caught: unknown,
  ): ConnectorResponse {
    const error = caught instanceof Error ? caught : new Error('Unknown Nova media error');
    const type = this.errorType(error);
    return {
      id: randomUUID(),
      connector: this.name,
      model: request.model ?? 'unknown',
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: Date.now() - startedAt,
      queueWaitMs: 0,
      status: type === 'rate_limited' ? 'rate_limited' : 'error',
      error: { type, message: error.message, ...classifyErrorAction(type) },
    };
  }

  private errorType(error: Error): string {
    if (error instanceof NovaMediaNotConfiguredError) return 'not_configured';
    if (!(error instanceof NovaMediaHttpError)) return 'validation_error';
    if (error.status === 429) return 'rate_limited';
    if (error.status === 401 || error.status === 403) return 'auth_error';
    if (error.status === 400) return 'validation_error';
    return error.status >= 500 ? 'server_error' : 'http_error';
  }
}

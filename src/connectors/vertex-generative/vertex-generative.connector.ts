import { Inject, Injectable } from '@nestjs/common';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  classifyErrorAction,
} from '../interfaces/connector.interface';
import {
  VERTEX_GENERATIVE_CONFIG,
  VERTEX_GENERATIVE_TOKEN_PROVIDER,
  VertexBearerTokenProvider,
  VertexGenerativeConfig,
} from './vertex-generative.tokens';

interface VertexResponse {
  candidates?: Array<{
    content?: { parts?: Array<Record<string, unknown>> };
    [key: string]: unknown;
  }>;
  promptFeedback?: unknown;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    [key: string]: unknown;
  };
  modelVersion?: string;
  responseId?: string;
  [key: string]: unknown;
}

@Injectable()
export class VertexGenerativeConnector extends BaseApiConnector {
  readonly name = 'vertex-generative';

  constructor(
    @Inject(VERTEX_GENERATIVE_CONFIG) private readonly config: VertexGenerativeConfig,
    @Inject(VERTEX_GENERATIVE_TOKEN_PROVIDER)
    private readonly tokenProvider: VertexBearerTokenProvider,
  ) {
    super();
  }

  protected get supportsContentBlocks(): boolean {
    return true;
  }

  protected getBaseUrl(): string {
    return `https://${encodeURIComponent(this.config.location)}-aiplatform.googleapis.com`;
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    const model = request.model ?? this.config.models[0];
    if (!model || !this.config.models.includes(model)) {
      throw new Error(`Vertex model is not configured: ${model ?? '(empty)'}`);
    }
    const location = encodeURIComponent(this.config.location);
    return (
      `${this.getBaseUrl()}/v1/projects/${encodeURIComponent(this.config.project)}` +
      `/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:generateContent`
    );
  }

  protected async getHeaders(): Promise<Record<string, string>> {
    const token = (await this.tokenProvider()).trim();
    if (!token) throw new Error('Vertex bearer-token provider returned an empty token');
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const parts =
      typeof request.prompt === 'string'
        ? [{ text: request.prompt }]
        : request.prompt.map((block) =>
            block.type === 'text'
              ? { text: block.text }
              : { fileData: { fileUri: block.image_url.url } },
          );
    const generationConfig = {
      ...this.readGenerationConfig(request.extra?.generationConfig),
      ...(request.jsonSchema
        ? { responseMimeType: 'application/json', responseSchema: request.jsonSchema }
        : {}),
    };

    return {
      contents: [{ role: 'user', parts }],
      ...(request.systemPrompt
        ? { systemInstruction: { role: 'system', parts: [{ text: request.systemPrompt }] } }
        : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    };
  }

  private readGenerationConfig(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const allowed = new Set([
      'temperature',
      'topP',
      'topK',
      'candidateCount',
      'maxOutputTokens',
      'stopSequences',
      'responseMimeType',
      'responseSchema',
    ]);
    return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)));
  }

  protected parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const response = (json ?? {}) as VertexResponse;
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    const text = candidates
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
    const usage = response.usageMetadata ?? {};
    return {
      text,
      structured: {
        candidates,
        promptFeedback: response.promptFeedback,
        usageMetadata: response.usageMetadata,
        modelVersion: response.modelVersion,
        responseId: response.responseId,
      },
      model: response.modelVersion ?? request.model ?? this.config.models[0] ?? 'unknown',
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      costUsd: 0,
      isError: false,
    };
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const model = request.model ?? this.config.models[0];
    if (!model || !this.config.models.includes(model)) {
      const action = classifyErrorAction('validation_error');
      return {
        id: 'vertex-validation-error',
        connector: this.name,
        model: model ?? 'unknown',
        result: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        latencyMs: 0,
        queueWaitMs: 0,
        status: 'error',
        error: {
          type: 'validation_error',
          message: `Vertex model is not configured: ${model}`,
          ...action,
        },
      };
    }
    return super.execute(request);
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: [...this.config.models],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 120_000,
    };
  }
}

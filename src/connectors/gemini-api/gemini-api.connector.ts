import { randomUUID } from 'node:crypto';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ProviderModelMeta,
  classifyErrorAction,
} from '../interfaces/connector.interface';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const STATIC_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];
const EMBEDDING_MODELS = new Set(['gemini-embedding-2', 'gemini-embedding-001']);
const EMBEDDING_TASK_TYPES = new Set([
  'SEMANTIC_SIMILARITY',
  'CLASSIFICATION',
  'CLUSTERING',
  'RETRIEVAL_DOCUMENT',
  'RETRIEVAL_QUERY',
  'CODE_RETRIEVAL_QUERY',
  'QUESTION_ANSWERING',
  'FACT_VERIFICATION',
]);
const REDACTION_MARKER = '[REDACTED]';
const MAX_REDACTION_DEPTH = 12;
const MAX_REDACTION_NODES = 2_000;

interface GeminiApiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
  modelVersion?: unknown;
}

interface GeminiEmbeddingResponse {
  embedding?: { values?: unknown };
  embeddings?: Array<{ values?: unknown }>;
  usageMetadata?: { promptTokenCount?: unknown };
}

interface GeminiModelList {
  models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }>;
  nextPageToken?: unknown;
}

interface EmbeddingContext {
  model: string;
  inputs: string[];
  config?: Record<string, unknown>;
  batch: boolean;
}

/** Native Gemini Developer API connector with the explicit AU-027 embeddings extension. */
export class GeminiApiConnector extends BaseApiConnector {
  readonly name = 'gemini-api';

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    if (this.isEmbeddingsRequest(request)) {
      try {
        this.getEmbeddingContext(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid Gemini embeddings request';
        const action = classifyErrorAction('validation_error');
        return {
          id: randomUUID(),
          connector: this.name,
          model: request.model || 'unknown',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 0,
          queueWaitMs: 0,
          status: 'error',
          error: { type: 'validation_error', message, ...action },
        };
      }
    }

    const apiKey = process.env.GEMINI_API_KEY || '';
    const response = await super.execute(request);
    return apiKey ? this.redactResponse(response, apiKey) : response;
  }

  protected getBaseUrl(): string {
    return (process.env.GEMINI_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  protected getTimeout(): number {
    return Number(process.env.GEMINI_API_TIMEOUT_MS) || 120_000;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY || '',
    };
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    if (this.isEmbeddingsRequest(request)) {
      const context = this.getEmbeddingContext(request);
      const method = context.batch ? 'batchEmbedContents' : 'embedContent';
      return `${this.getBaseUrl()}/models/${encodeURIComponent(context.model)}:${method}`;
    }

    const model = (request.model || DEFAULT_MODEL).replace(/^models\//, '');
    return `${this.getBaseUrl()}/models/${encodeURIComponent(model)}:generateContent`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (this.isEmbeddingsRequest(request)) return this.buildEmbeddingRequestBody(request);
    if (typeof request.prompt !== 'string') {
      throw new Error('gemini-api connector requires a string prompt');
    }

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
    };
    if (request.systemPrompt) body.system_instruction = { parts: [{ text: request.systemPrompt }] };

    const generationConfig: Record<string, unknown> = {};
    if (request.responseFormat?.type === 'json_object' || request.jsonSchema) {
      generationConfig.responseMimeType = 'application/json';
    }
    if (request.jsonSchema) generationConfig.responseSchema = request.jsonSchema;
    const extra = request.extra ?? {};
    if (typeof extra.temperature === 'number') generationConfig.temperature = extra.temperature;
    if (typeof extra.top_p === 'number') generationConfig.topP = extra.top_p;
    if (typeof extra.top_k === 'number') generationConfig.topK = extra.top_k;
    if (typeof extra.max_tokens === 'number') generationConfig.maxOutputTokens = extra.max_tokens;
    if (Array.isArray(extra.stop) && extra.stop.every((item) => typeof item === 'string')) {
      generationConfig.stopSequences = extra.stop;
    }
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    return body;
  }

  protected parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    if (this.isEmbeddingsRequest(request)) return this.parseEmbeddingResponse(json, request);
    const response = json as GeminiApiResponse;
    const inputTokens = numberOrZero(response.usageMetadata?.promptTokenCount);
    const outputTokens = numberOrZero(response.usageMetadata?.candidatesTokenCount);
    const model =
      typeof response.modelVersion === 'string'
        ? response.modelVersion
        : request.model || DEFAULT_MODEL;
    const candidate = response.candidates?.[0];
    if (!candidate) {
      const reason =
        typeof response.promptFeedback?.blockReason === 'string'
          ? `: ${response.promptFeedback.blockReason}`
          : '';
      return {
        text: '', model, inputTokens, outputTokens, costUsd: 0, isError: true,
        errorMessage: `Gemini API returned no candidates${reason}`,
      };
    }

    const text = (candidate.content?.parts ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
    let structured: unknown;
    if (request.responseFormat?.type === 'json_object' || request.jsonSchema) {
      try {
        structured = JSON.parse(text);
      } catch {
        return {
          text, model, inputTokens, outputTokens, costUsd: 0, isError: true,
          errorMessage: 'Gemini API returned malformed structured JSON',
        };
      }
    }
    return { text, structured, model, inputTokens, outputTokens, costUsd: 0, isError: false };
  }

  protected getStaticModels(): string[] {
    return STATIC_MODELS;
  }

  protected getModelsUrl(): string {
    return `${this.getBaseUrl()}/models?pageSize=1000`;
  }

  protected extractModels(json: GeminiModelList): ProviderModelMeta[] {
    if (!Array.isArray(json.models)) return [];
    return json.models.flatMap((entry) => {
      if (
        typeof entry.name !== 'string' ||
        !Array.isArray(entry.supportedGenerationMethods) ||
        !entry.supportedGenerationMethods.includes('generateContent')
      ) {
        return [];
      }
      const id = entry.name.replace(/^models\//, '');
      return id ? [{ id }] : [];
    });
  }

  protected getNextModelsUrl(json: GeminiModelList): string | undefined {
    if (typeof json.nextPageToken !== 'string' || json.nextPageToken.length === 0) return undefined;
    return `${this.getModelsUrl()}&pageToken=${encodeURIComponent(json.nextPageToken)}`;
  }

  protected getHealthProbePath(): string {
    return '/models?pageSize=1';
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta = this.dynamicModelMetas;
    return {
      name: this.name,
      type: 'api',
      models: modelMeta.map((model) => model.id),
      modelMeta,
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }

  private isEmbeddingsRequest(request: ConnectorRequest): boolean {
    return request.extra?.operation === 'embeddings';
  }

  private getEmbeddingContext(request: ConnectorRequest): EmbeddingContext {
    const model = typeof request.model === 'string' ? request.model.replace(/^models\//, '') : '';
    if (!EMBEDDING_MODELS.has(model)) {
      throw new Error('Gemini embeddings requires a supported embedding model');
    }
    const extra = request.extra ?? {};
    for (const field of ['fileData', 'inlineData', 'asyncBatch'] as const) {
      if (extra[field] !== undefined) throw new Error(`Gemini embeddings does not support ${field}`);
    }
    const input = Object.prototype.hasOwnProperty.call(extra, 'input') ? extra.input : request.prompt;
    const inputs = typeof input === 'string' ? [input] : input;
    if (
      !Array.isArray(inputs) ||
      inputs.length === 0 ||
      !inputs.every((item) => typeof item === 'string' && item.length > 0)
    ) {
      throw new Error('Gemini embeddings input must be non-empty text or a non-empty text array');
    }

    const config: Record<string, unknown> = {};
    if (extra.outputDimensionality !== undefined) {
      if (!Number.isInteger(extra.outputDimensionality) || (extra.outputDimensionality as number) < 1) {
        throw new Error('Gemini embeddings outputDimensionality must be a positive integer');
      }
      config.outputDimensionality = extra.outputDimensionality;
    }
    if (extra.taskType !== undefined) {
      if (model !== 'gemini-embedding-001' || !EMBEDDING_TASK_TYPES.has(String(extra.taskType))) {
        throw new Error('Gemini embeddings taskType is unsupported for this model');
      }
      config.taskType = extra.taskType;
    }
    if (extra.title !== undefined) {
      if (
        model !== 'gemini-embedding-001' ||
        extra.taskType !== 'RETRIEVAL_DOCUMENT' ||
        typeof extra.title !== 'string' ||
        extra.title.length === 0
      ) {
        throw new Error('Gemini embeddings title requires RETRIEVAL_DOCUMENT');
      }
      config.title = extra.title;
    }
    return { model, inputs, config: Object.keys(config).length ? config : undefined, batch: inputs.length > 1 };
  }

  private buildEmbeddingRequestBody(request: ConnectorRequest): Record<string, unknown> {
    const context = this.getEmbeddingContext(request);
    const model = `models/${context.model}`;
    const makeRequest = (text: string): Record<string, unknown> => ({
      model,
      content: { parts: [{ text }] },
      ...(context.config ? { embedContentConfig: context.config } : {}),
    });
    return context.batch
      ? { model, requests: context.inputs.map(makeRequest) }
      : makeRequest(context.inputs[0]);
  }

  private parseEmbeddingResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const response = json as GeminiEmbeddingResponse;
    const context = this.getEmbeddingContext(request);
    const rawEmbeddings = context.batch ? response.embeddings : [response.embedding];
    const embeddings = Array.isArray(rawEmbeddings)
      ? rawEmbeddings.map((item) => item?.values)
      : [];
    const valid =
      embeddings.length === context.inputs.length &&
      embeddings.every(
        (values) =>
          Array.isArray(values) &&
          values.length > 0 &&
          values.every((value) => typeof value === 'number' && Number.isFinite(value)),
      );
    if (!valid) {
      return {
        text: '',
        model: context.model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'Gemini embeddings returned an invalid response envelope',
      };
    }
    const usageMetadata = {
      promptTokenCount: numberOrZero(response.usageMetadata?.promptTokenCount),
    };
    return {
      text: JSON.stringify(embeddings),
      structured: { embeddings, usageMetadata },
      model: context.model,
      inputTokens: usageMetadata.promptTokenCount,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }

  private redactResponse(response: ConnectorResponse, apiKey: string): ConnectorResponse {
    const seen = new WeakMap<object, unknown>();
    let visited = 0;
    const visit = (value: unknown, depth: number): unknown => {
      if (typeof value === 'string') return value.split(apiKey).join(REDACTION_MARKER);
      if (typeof value !== 'object' || value === null) return value;
      if (depth > MAX_REDACTION_DEPTH || visited++ >= MAX_REDACTION_NODES) {
        throw new Error('Gemini API response redaction bound exceeded');
      }
      const prior = seen.get(value);
      if (prior !== undefined) return prior;
      const output: unknown = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
      seen.set(value, output);
      const target = output as Record<string, unknown>;
      for (const [key, nested] of Object.entries(value)) {
        const redactedKey = key.split(apiKey).join(REDACTION_MARKER);
        if (Object.prototype.hasOwnProperty.call(target, redactedKey)) {
          throw new Error('Gemini API response redaction key collision');
        }
        target[redactedKey] = visit(nested, depth + 1);
      }
      return output;
    };
    try {
      return visit(response, 0) as ConnectorResponse;
    } catch {
      const action = classifyErrorAction(response.error?.type ?? 'api_error');
      return {
        id: randomUUID(), connector: this.name, model: response.model, result: '', usage: response.usage,
        latencyMs: response.latencyMs, queueWaitMs: response.queueWaitMs, status: 'error',
        error: {
          type: response.error?.type ?? 'api_error',
          message: 'Gemini API response exceeded safe redaction bounds',
          ...action,
        },
      };
    }
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

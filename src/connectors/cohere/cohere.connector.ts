import { AsyncLocalStorage } from 'async_hooks';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  CatalogRefreshResult,
  classifyErrorAction,
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ProviderModelMeta,
} from '../interfaces/connector.interface';

type CohereOperation = 'embed' | 'rerank';
type CohereInputType =
  | 'search_document'
  | 'search_query'
  | 'classification'
  | 'clustering'
  | 'image';
type CohereEmbeddingType = 'float' | 'int8' | 'uint8' | 'binary' | 'ubinary' | 'base64';

interface CohereChatResponse {
  finish_reason?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  usage?: {
    billed_units?: { input_tokens?: number; output_tokens?: number };
    tokens?: { input_tokens?: number; output_tokens?: number };
  };
}

interface CohereModel {
  name?: unknown;
  is_deprecated?: unknown;
  endpoints?: unknown;
  context_length?: unknown;
}

interface CohereModelsPage {
  models?: unknown;
  next_page_token?: unknown;
}

interface CohereEmbedResponse {
  id?: unknown;
  embeddings?: unknown;
  meta?: unknown;
}

interface CohereRerankResponse {
  id?: unknown;
  results?: unknown;
  meta?: unknown;
}

type SanitizedInputComponent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface SanitizedEmbedInput {
  content: SanitizedInputComponent[];
}

const DEFAULT_MODEL = 'command-a-03-2025';
const MAX_EMBED_INPUTS = 96;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const INPUT_TYPES = new Set<CohereInputType>([
  'search_document',
  'search_query',
  'classification',
  'clustering',
  'image',
]);
const EMBEDDING_TYPES = new Set<CohereEmbeddingType>([
  'float',
  'int8',
  'uint8',
  'binary',
  'ubinary',
  'base64',
]);
const OUTPUT_DIMENSIONS = new Set([256, 512, 1024, 1536]);
const TRUNCATE_VALUES = new Set(['NONE', 'START', 'END']);
const REDACTION_MARKER = '[REDACTED]';
const MAX_REDACTION_DEPTH = 64;
const MAX_REDACTION_NODES = 10_000;

/** Native Cohere Chat connector with explicit AU-029 Embed and Rerank operations. */
export class CohereConnector extends BaseApiConnector {
  readonly name = 'cohere';

  private readonly apiKeyContext = new AsyncLocalStorage<string>();
  private chatModelMetas?: ProviderModelMeta[];
  private operationModelMetas: Record<CohereOperation, ProviderModelMeta[]> = {
    embed: [],
    rerank: [],
  };

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const apiKey = process.env.COHERE_API_KEY || '';
    const response = await this.apiKeyContext.run(apiKey, () => super.execute(request));
    if (apiKey.length === 0) return response;

    try {
      return this.redactResponse(response, apiKey);
    } catch {
      const action = classifyErrorAction(response.error?.type ?? 'api_error');
      return {
        id: this.redactString(response.id, apiKey),
        connector: this.name,
        model: this.redactString(response.model, apiKey),
        result: '',
        usage: response.usage,
        latencyMs: response.latencyMs,
        queueWaitMs: response.queueWaitMs,
        status: 'error',
        error: {
          type: response.error?.type ?? 'api_error',
          message: 'Cohere response exceeded safe redaction bounds',
          ...action,
        },
      };
    }
  }

  protected getBaseUrl(): string {
    return (process.env.COHERE_BASE_URL || 'https://api.cohere.com').replace(/\/$/, '');
  }

  protected getTimeout(): number {
    return Number(process.env.COHERE_TIMEOUT_MS) || 120_000;
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = this.apiKeyContext.getStore() ?? process.env.COHERE_API_KEY ?? '';
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    const operation = this.getOperation(request);
    if (operation === 'embed') return `${this.getBaseUrl()}/v2/embed`;
    if (operation === 'rerank') return `${this.getBaseUrl()}/v2/rerank`;
    return `${this.getBaseUrl()}/v2/chat`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const operation = this.getOperation(request);
    if (operation === 'embed') return this.buildEmbedRequestBody(request);
    if (operation === 'rerank') return this.buildRerankRequestBody(request);
    return this.buildChatRequestBody(request);
  }

  protected parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const operation = this.getOperation(request);
    if (operation === 'embed') return this.parseEmbedResponse(json, request);
    if (operation === 'rerank') return this.parseRerankResponse(json, request);
    return this.parseChatResponse(json, request);
  }

  protected getStaticModels(): string[] {
    return [DEFAULT_MODEL];
  }

  protected getModelsUrl(): string {
    return `${this.getBaseUrl()}/v1/models?page_size=1000`;
  }

  protected extractModels(json: unknown): ProviderModelMeta[] {
    return this.extractModelsForEndpoint(json, 'chat');
  }

  async refreshModels(): Promise<CatalogRefreshResult> {
    const checkedAt = new Date();
    try {
      const models: ProviderModelMeta[] = [];
      const seen = new Set<string>();
      let nextPageToken: string | undefined;
      do {
        const page = await this.fetchModelsPage(nextPageToken);
        if (page === undefined) {
          return { status: 'failed', source: 'provider-api', checkedAt, reason: 'http' };
        }
        for (const model of this.extractModels(page)) {
          if (!seen.has(model.id)) {
            seen.add(model.id);
            models.push(model);
          }
        }
        nextPageToken = this.getNextPageToken(page);
      } while (nextPageToken);
      if (models.length === 0) {
        return { status: 'failed', source: 'provider-api', checkedAt, reason: 'empty' };
      }
      this.chatModelMetas = models;
      return { status: 'success', source: 'provider-api', observedAt: new Date() };
    } catch {
      // Preserve the static/cached Chat catalogue on any provider or parsing failure.
      return { status: 'failed', source: 'provider-api', checkedAt, reason: 'network' };
    }
  }

  async refreshOperationModels(): Promise<void> {
    try {
      const models: Record<CohereOperation, ProviderModelMeta[]> = { embed: [], rerank: [] };
      const seen: Record<CohereOperation, Set<string>> = {
        embed: new Set<string>(),
        rerank: new Set<string>(),
      };
      let nextPageToken: string | undefined;
      do {
        const page = await this.fetchModelsPage(nextPageToken);
        if (page === undefined) return;
        for (const operation of ['embed', 'rerank'] as const) {
          for (const model of this.extractModelsForEndpoint(page, operation)) {
            if (!seen[operation].has(model.id)) {
              seen[operation].add(model.id);
              models[operation].push(model);
            }
          }
        }
        nextPageToken = this.getNextPageToken(page);
      } while (nextPageToken);
      this.operationModelMetas = models;
    } catch {
      // Preserve the cached operation catalogues on any provider or parsing failure.
    }
  }

  getOperationModels(operation: CohereOperation): ProviderModelMeta[] {
    return this.operationModelMetas[operation].map((model) => ({ ...model }));
  }

  protected getHealthProbePath(): string {
    return '/v1/models?page_size=1';
  }

  protected classifyHttpError(status: number, body: string): string {
    if (status === 401 || status === 403 || status === 498) return 'auth_error';
    if (status === 404) return 'model_not_found';
    if (status === 400 || status === 422) return 'validation_error';
    if (status === 429) return 'rate_limited';
    if (status === 499 || status === 504) return 'timeout';
    if (status >= 500) return 'server_error';
    return super.classifyHttpError(status, body);
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta = this.chatModelMetas ?? this.getStaticModelMetas();
    return {
      name: this.name,
      type: this.type,
      models: modelMeta.map((model) => model.id),
      modelMeta,
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }

  private getOperation(request: ConnectorRequest): CohereOperation | undefined {
    const operation = request.extra?.operation;
    return operation === 'embed' || operation === 'rerank' ? operation : undefined;
  }

  private buildChatRequestBody(request: ConnectorRequest): Record<string, unknown> {
    if (typeof request.prompt !== 'string') {
      throw new Error('cohere connector requires a string prompt');
    }
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    const body: Record<string, unknown> = { model: request.model || DEFAULT_MODEL, messages };
    if (request.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    for (const key of ['max_tokens', 'temperature', 'p', 'k', 'stop_sequences'] as const) {
      if (request.extra?.[key] !== undefined) body[key] = request.extra[key];
    }
    return body;
  }

  private buildEmbedRequestBody(request: ConnectorRequest): Record<string, unknown> {
    const model = this.requireModel(request, 'Embed');
    const extra = request.extra ?? {};
    const sourceKeys = (['texts', 'images', 'inputs'] as const).filter(
      (key) => extra[key] !== undefined,
    );
    if (sourceKeys.length !== 1) {
      throw new Error('Cohere Embed requires exactly one of texts, images, or inputs');
    }
    if (
      typeof extra.input_type !== 'string' ||
      !INPUT_TYPES.has(extra.input_type as CohereInputType)
    ) {
      throw new Error('Cohere Embed input_type is invalid');
    }

    const body: Record<string, unknown> = { model, input_type: extra.input_type };
    const source = sourceKeys[0];
    if (source === 'texts') body.texts = this.sanitizeTexts(extra.texts);
    if (source === 'images') body.images = this.sanitizeImages(extra.images);
    if (source === 'inputs') body.inputs = this.sanitizeInputs(extra.inputs);

    if (extra.embedding_types !== undefined) {
      if (
        !Array.isArray(extra.embedding_types) ||
        extra.embedding_types.length === 0 ||
        !extra.embedding_types.every(
          (type) => typeof type === 'string' && EMBEDDING_TYPES.has(type as CohereEmbeddingType),
        )
      ) {
        throw new Error('Cohere Embed embedding_types is invalid');
      }
      body.embedding_types = [...extra.embedding_types];
    }
    if (extra.output_dimension !== undefined) {
      if (
        !Number.isInteger(extra.output_dimension) ||
        !OUTPUT_DIMENSIONS.has(extra.output_dimension as number) ||
        !this.isEmbedV4OrNewer(model)
      ) {
        throw new Error('Cohere Embed output_dimension requires Embed v4+ and a documented value');
      }
      body.output_dimension = extra.output_dimension;
    }
    if (extra.truncate !== undefined) {
      if (typeof extra.truncate !== 'string' || !TRUNCATE_VALUES.has(extra.truncate)) {
        throw new Error('Cohere Embed truncate is invalid');
      }
      body.truncate = extra.truncate;
    }
    if (extra.max_tokens !== undefined) {
      this.requirePositiveInteger(extra.max_tokens, 'Cohere Embed max_tokens');
      body.max_tokens = extra.max_tokens;
    }
    if (extra.priority !== undefined) {
      this.requirePriority(extra.priority, 'Cohere Embed priority');
      body.priority = extra.priority;
    }
    return body;
  }

  private buildRerankRequestBody(request: ConnectorRequest): Record<string, unknown> {
    const model = this.requireModel(request, 'Rerank');
    const extra = request.extra ?? {};
    if (typeof extra.query !== 'string' || extra.query.length === 0) {
      throw new Error('Cohere Rerank requires a non-empty query');
    }
    if (
      !Array.isArray(extra.documents) ||
      extra.documents.length === 0 ||
      !extra.documents.every((document) => typeof document === 'string' && document.length > 0)
    ) {
      throw new Error('Cohere Rerank requires non-empty string documents');
    }

    const body: Record<string, unknown> = {
      model,
      query: extra.query,
      documents: [...extra.documents],
    };
    if (extra.top_n !== undefined) {
      this.requirePositiveInteger(extra.top_n, 'Cohere Rerank top_n');
      body.top_n = extra.top_n;
    }
    if (extra.max_tokens_per_doc !== undefined) {
      this.requirePositiveInteger(extra.max_tokens_per_doc, 'Cohere Rerank max_tokens_per_doc');
      body.max_tokens_per_doc = extra.max_tokens_per_doc;
    }
    if (extra.priority !== undefined) {
      this.requirePriority(extra.priority, 'Cohere Rerank priority');
      body.priority = extra.priority;
    }
    return body;
  }

  private parseChatResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const response = json as CohereChatResponse;
    const finishReason = response.finish_reason ?? 'ERROR';
    const text = (response.message?.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    const usage = response.usage?.billed_units ?? response.usage?.tokens;
    const isError = finishReason === 'ERROR' || finishReason === 'TIMEOUT';
    let structured: unknown;
    if (!isError && request.responseFormat?.type === 'json_object' && text) {
      try {
        structured = JSON.parse(text);
      } catch {
        // The existing output guard handles malformed Chat JSON.
      }
    }
    return {
      text,
      structured,
      model: request.model || DEFAULT_MODEL,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      costUsd: 0,
      isError,
      errorMessage: isError ? `Cohere generation finished with ${finishReason}` : undefined,
    };
  }

  private parseEmbedResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const response = json as CohereEmbedResponse;
    if (
      typeof response?.id !== 'string' ||
      !this.isValidEmbeddings(response.embeddings) ||
      !this.isRecord(response.meta)
    ) {
      return this.invalidOperationResponse(request, 'Embed');
    }
    const inputTokens = this.readBilledUnit(response.meta, 'input_tokens');
    return {
      text: JSON.stringify(response.embeddings),
      structured: response,
      model: request.model || 'unknown',
      inputTokens,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }

  private parseRerankResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const response = json as CohereRerankResponse;
    if (
      typeof response?.id !== 'string' ||
      !Array.isArray(response.results) ||
      response.results.length === 0 ||
      !response.results.every((result) => this.isValidRerankResult(result)) ||
      !this.isRecord(response.meta)
    ) {
      return this.invalidOperationResponse(request, 'Rerank');
    }
    return {
      text: JSON.stringify(response.results),
      structured: response,
      model: request.model || 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }

  private invalidOperationResponse(request: ConnectorRequest, operation: string): ParsedApiOutput {
    return {
      text: '',
      model: request.model || 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: true,
      errorMessage: `Cohere ${operation} returned an invalid response envelope`,
    };
  }

  private requireModel(request: ConnectorRequest, operation: string): string {
    if (typeof request.model !== 'string' || request.model.trim().length === 0) {
      throw new Error(`Cohere ${operation} requires a model`);
    }
    return request.model;
  }

  private sanitizeTexts(value: unknown): string[] {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > MAX_EMBED_INPUTS ||
      !value.every((text) => typeof text === 'string' && text.length > 0)
    ) {
      throw new Error('Cohere Embed texts is invalid');
    }
    return [...value];
  }

  private sanitizeImages(value: unknown): string[] {
    if (!Array.isArray(value) || value.length !== 1 || !this.isValidImageDataUri(value[0])) {
      throw new Error('Cohere Embed images is invalid');
    }
    return [...value] as string[];
  }

  private sanitizeInputs(value: unknown): SanitizedEmbedInput[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EMBED_INPUTS) {
      throw new Error('Cohere Embed inputs is invalid');
    }
    return value.map((input) => {
      if (!this.isRecord(input) || !Array.isArray(input.content) || input.content.length === 0) {
        throw new Error('Cohere Embed inputs is invalid');
      }
      const content = input.content.map((component): SanitizedInputComponent => {
        if (
          this.isRecord(component) &&
          component.type === 'text' &&
          typeof component.text === 'string' &&
          component.text.length > 0
        ) {
          return { type: 'text', text: component.text };
        }
        if (
          this.isRecord(component) &&
          component.type === 'image_url' &&
          this.isRecord(component.image_url) &&
          this.isValidImageDataUri(component.image_url.url)
        ) {
          return { type: 'image_url', image_url: { url: component.image_url.url as string } };
        }
        throw new Error('Cohere Embed input content is invalid');
      });
      return { content };
    });
  }

  private isValidImageDataUri(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const match = /^data:image\/(?:jpeg|png|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
    if (!match || match[1].length === 0 || match[1].length % 4 !== 0) return false;
    const padding = match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0;
    const decodedBytes = (match[1].length * 3) / 4 - padding;
    return decodedBytes <= MAX_IMAGE_BYTES;
  }

  private isEmbedV4OrNewer(model: string): boolean {
    const match = /^embed-v(\d+)(?:\.|$)/.exec(model);
    return match !== null && Number(match[1]) >= 4;
  }

  private requirePositiveInteger(value: unknown, field: string): void {
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new Error(`${field} must be a positive integer`);
    }
  }

  private requirePriority(value: unknown, field: string): void {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 999) {
      throw new Error(`${field} must be an integer from 0 through 999`);
    }
  }

  private isValidEmbeddings(value: unknown): boolean {
    if (!this.isRecord(value)) return false;
    const entries = Object.entries(value);
    if (entries.length === 0) return false;
    return entries.every(([type, embeddings]) => {
      if (!EMBEDDING_TYPES.has(type as CohereEmbeddingType) || !Array.isArray(embeddings)) {
        return false;
      }
      if (type === 'base64') {
        return embeddings.length > 0 && embeddings.every((item) => typeof item === 'string');
      }
      return (
        embeddings.length > 0 &&
        embeddings.every(
          (embedding) =>
            Array.isArray(embedding) &&
            embedding.length > 0 &&
            embedding.every(
              (component) => typeof component === 'number' && Number.isFinite(component),
            ),
        )
      );
    });
  }

  private isValidRerankResult(value: unknown): boolean {
    if (!this.isRecord(value)) return false;
    return (
      Number.isInteger(value.index) &&
      (value.index as number) >= 0 &&
      typeof value.relevance_score === 'number' &&
      Number.isFinite(value.relevance_score)
    );
  }

  private readBilledUnit(meta: Record<string, unknown>, field: string): number {
    const billedUnits = meta.billed_units;
    if (!this.isRecord(billedUnits)) return 0;
    const value = billedUnits[field];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private extractModelsForEndpoint(
    json: unknown,
    endpoint: CohereOperation | 'chat',
  ): ProviderModelMeta[] {
    const models = (json as { models?: unknown })?.models;
    if (!Array.isArray(models)) return [];
    return (models as CohereModel[])
      .filter(
        (model) =>
          typeof model.name === 'string' &&
          model.is_deprecated !== true &&
          Array.isArray(model.endpoints) &&
          model.endpoints.includes(endpoint),
      )
      .map((model) => ({
        id: model.name as string,
        ...(typeof model.context_length === 'number'
          ? { contextWindow: model.context_length }
          : {}),
      }));
  }

  private async fetchModelsPage(nextPageToken?: string): Promise<CohereModelsPage | undefined> {
    const url = new URL(this.getModelsUrl());
    if (nextPageToken) url.searchParams.set('page_token', nextPageToken);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: await this.getModelsHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as CohereModelsPage;
  }

  private getNextPageToken(page: CohereModelsPage): string | undefined {
    return typeof page.next_page_token === 'string' && page.next_page_token.length > 0
      ? page.next_page_token
      : undefined;
  }

  private redactResponse(response: ConnectorResponse, apiKey: string): ConnectorResponse {
    const seen = new WeakMap<object, unknown>();
    let visited = 0;

    const visit = (value: unknown, depth: number): unknown => {
      if (typeof value === 'string') return this.redactString(value, apiKey);
      if (typeof value !== 'object' || value === null) return value;
      if (depth > MAX_REDACTION_DEPTH || visited++ >= MAX_REDACTION_NODES) {
        throw new Error('Cohere response redaction bound exceeded');
      }

      const prior = seen.get(value);
      if (prior !== undefined) return prior;

      const output: unknown[] | Record<string, unknown> = Array.isArray(value)
        ? []
        : Object.create(Object.getPrototypeOf(value));
      seen.set(value, output);
      const target = output as Record<string, unknown>;

      for (const [key, nested] of Object.entries(value)) {
        const redactedKey = this.redactString(key, apiKey);
        if (Object.prototype.hasOwnProperty.call(target, redactedKey)) {
          throw new Error('Cohere response redaction key collision');
        }
        target[redactedKey] = visit(nested, depth + 1);
      }
      return output;
    };

    return visit(response, 0) as ConnectorResponse;
  }

  private redactString(value: string, apiKey: string): string {
    return value.split(apiKey).join(REDACTION_MARKER);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

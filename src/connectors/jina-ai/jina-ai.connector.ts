import { randomUUID } from 'crypto';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ProviderModelMeta,
  classifyErrorAction,
} from '../interfaces/connector.interface';

type JinaOperation = 'embeddings' | 'rerank';
type JinaEmbeddingType = 'float' | 'base64' | 'binary' | 'ubinary';

type TextDoc = { text: string };
type ImageDoc = { image: string };
type PdfDoc = { pdf: string };

interface JinaResponse {
  data?: unknown;
  results?: unknown;
  model?: unknown;
  usage?: { total_tokens?: unknown };
}

const BASE_URL = 'https://api.jina.ai';
const DEFAULT_EMBEDDING_MODEL = 'jina-embeddings-v4';
const DEFAULT_RERANK_MODEL = 'jina-reranker-v3';

const EMBEDDING_MODELS = ['jina-embeddings-v3', 'jina-embeddings-v4'] as const;
const RERANK_MODELS = [
  'jina-reranker-v2-base-multilingual',
  'jina-reranker-m0',
  'jina-reranker-v3',
] as const;

const EMBEDDING_MODEL_SET = new Set<string>(EMBEDDING_MODELS);
const RERANK_MODEL_SET = new Set<string>(RERANK_MODELS);
const EMBEDDING_TYPES = new Set<JinaEmbeddingType>(['float', 'base64', 'binary', 'ubinary']);
const V3_TASKS = new Set([
  'retrieval.query',
  'retrieval.passage',
  'text-matching',
  'classification',
  'separation',
]);
const V4_TASKS = new Set([
  'text-matching',
  'retrieval.query',
  'retrieval.passage',
  'code.query',
  'code.passage',
]);

/**
 * AU-024 public Jina Search Foundation REST adapter.
 *
 * Frozen first-party contract (2026-07-15):
 * https://api.jina.ai/openapi.json (version 2026.06.29.1712)
 * https://jina.ai/en-US/embeddings/
 * https://jina.ai/en-US/reranker/
 */
export class JinaAiConnector extends BaseApiConnector {
  readonly name = 'jina-ai';

  protected getBaseUrl(): string {
    return BASE_URL;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.JINA_API_KEY ?? ''}`,
    };
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/v1/${this.getOperation(request)}`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    return this.getOperation(request) === 'rerank'
      ? this.buildRerankBody(request)
      : this.buildEmbeddingsBody(request);
  }

  protected parseResponse(json: JinaResponse, request: ConnectorRequest): ParsedApiOutput {
    const operation = this.getOperation(request);
    const result = operation === 'rerank' ? json.results : json.data;
    if (!Array.isArray(result)) {
      return this.invalidProviderResponse(
        json,
        request,
        `Jina ${operation} response must contain a result array`,
      );
    }

    const totalTokens = json.usage?.total_tokens;
    if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) {
      return this.invalidProviderResponse(
        json,
        request,
        'Jina response usage.total_tokens must be a non-negative number',
      );
    }

    return {
      text: JSON.stringify(result),
      structured: result,
      model: typeof json.model === 'string' ? json.model : this.getModel(request),
      inputTokens: totalTokens,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const validationMessage = this.validateRequest(request);
    if (validationMessage) return this.validationError(request, validationMessage);

    const response = await super.execute(request);
    const apiKey = process.env.JINA_API_KEY ?? '';
    if (apiKey && response.error?.message.includes(apiKey)) {
      response.error.message = response.error.message.split(apiKey).join('[REDACTED]');
    }
    return response;
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta: ProviderModelMeta[] = [
      ...EMBEDDING_MODELS.map((id) => ({ id, modality: 'embedding' as const })),
      ...RERANK_MODELS.map((id) => ({ id, modality: 'rerank' as const })),
    ];

    return {
      name: this.name,
      type: 'api',
      models: modelMeta.map((model) => model.id),
      modelMeta,
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 120_000,
    };
  }

  private getOperation(request: ConnectorRequest): JinaOperation {
    return request.extra?.operation === 'rerank' ? 'rerank' : 'embeddings';
  }

  private getModel(request: ConnectorRequest): string {
    return (
      request.model ??
      (this.getOperation(request) === 'rerank' ? DEFAULT_RERANK_MODEL : DEFAULT_EMBEDDING_MODEL)
    );
  }

  private buildEmbeddingsBody(request: ConnectorRequest): Record<string, unknown> {
    const extra = request.extra ?? {};
    const body: Record<string, unknown> = {
      input: extra.inputs ?? request.prompt,
      model: this.getModel(request),
    };

    this.copyDefined(body, 'embedding_type', extra.embeddingType);
    this.copyDefined(body, 'truncate', extra.truncate);
    this.copyDefined(body, 'task', extra.task);
    this.copyDefined(body, 'late_chunking', extra.lateChunking);
    this.copyDefined(body, 'dimensions', extra.dimensions);

    if (this.getModel(request) === 'jina-embeddings-v3') {
      this.copyDefined(body, 'normalized', extra.normalized);
    } else {
      this.copyDefined(body, 'return_multivector', extra.returnMultivector);
      this.copyDefined(body, 'return_tokenized_input', extra.returnTokenizedInput);
    }
    return body;
  }

  private buildRerankBody(request: ConnectorRequest): Record<string, unknown> {
    const extra = request.extra ?? {};
    const body: Record<string, unknown> = {
      query: extra.query ?? request.prompt,
      documents: extra.documents,
      model: this.getModel(request),
    };

    this.copyDefined(body, 'top_n', extra.topN);
    this.copyDefined(body, 'return_documents', extra.returnDocuments);
    this.copyDefined(body, 'truncation', extra.truncation);
    if (this.getModel(request) === 'jina-reranker-v3') {
      this.copyDefined(body, 'max_doc_length', extra.maxDocLength);
      this.copyDefined(body, 'return_embeddings', extra.returnEmbeddings);
    }
    return body;
  }

  private copyDefined(
    target: Record<string, unknown>,
    providerField: string,
    value: unknown,
  ): void {
    if (value !== undefined) target[providerField] = value;
  }

  private validateRequest(request: ConnectorRequest): string | null {
    const operation = request.extra?.operation;
    if (operation !== undefined && operation !== 'embeddings' && operation !== 'rerank') {
      return "operation must be 'embeddings' or 'rerank'";
    }
    if (typeof request.prompt !== 'string') return 'input query must be a string';

    const model = this.getModel(request);
    if (this.getOperation(request) === 'rerank') {
      if (!RERANK_MODEL_SET.has(model)) return `${model} does not support the rerank operation`;
      return this.validateRerank(request);
    }
    if (!EMBEDDING_MODEL_SET.has(model)) {
      return `${model} does not support the embeddings operation`;
    }
    return this.validateEmbeddings(request);
  }

  private validateEmbeddings(request: ConnectorRequest): string | null {
    const extra = request.extra ?? {};
    const model = this.getModel(request);
    const inputs = extra.inputs ?? request.prompt;
    const inputError = this.validateEmbeddingInput(inputs, model);
    if (inputError) return inputError;

    if (
      extra.embeddingType !== undefined &&
      (typeof extra.embeddingType !== 'string' ||
        !EMBEDDING_TYPES.has(extra.embeddingType as JinaEmbeddingType))
    ) {
      return 'embeddingType must be float, base64, binary, or ubinary';
    }
    const commonBooleanError = this.validateBooleanOptions(extra, ['truncate']);
    if (commonBooleanError) return commonBooleanError;

    if (extra.dimensions !== undefined) {
      const max = model === 'jina-embeddings-v3' ? 1024 : 2048;
      if (!this.isIntegerInRange(extra.dimensions, 1, max)) {
        return `dimensions must be an integer between 1 and ${max}`;
      }
    }

    if (extra.task !== undefined) {
      const tasks = model === 'jina-embeddings-v3' ? V3_TASKS : V4_TASKS;
      if (typeof extra.task !== 'string' || !tasks.has(extra.task)) {
        return `task is not documented for ${model}`;
      }
    }

    if (extra.lateChunking !== undefined && typeof extra.lateChunking !== 'boolean') {
      return 'lateChunking must be a boolean';
    }
    if (extra.lateChunking === true && !this.isTextOnlyInput(inputs)) {
      return 'lateChunking is text-only';
    }

    if (model === 'jina-embeddings-v3') {
      if (extra.normalized !== undefined && typeof extra.normalized !== 'boolean') {
        return 'normalized must be a boolean';
      }
      if (extra.returnMultivector !== undefined || extra.returnTokenizedInput !== undefined) {
        return 'multivector options are v4-only';
      }
      return null;
    }

    if (extra.normalized !== undefined) return 'normalized is v3-only';
    const v4BooleanError = this.validateBooleanOptions(extra, [
      'returnMultivector',
      'returnTokenizedInput',
    ]);
    if (v4BooleanError) return v4BooleanError;
    if (extra.returnMultivector === true && extra.dimensions !== undefined) {
      return 'returnMultivector and dimensions are mutually exclusive';
    }
    if (extra.returnTokenizedInput === true && extra.returnMultivector !== true) {
      return 'returnTokenizedInput requires returnMultivector';
    }
    return null;
  }

  private validateRerank(request: ConnectorRequest): string | null {
    const extra = request.extra ?? {};
    const model = this.getModel(request);
    const query = extra.query ?? request.prompt;
    if (!this.isNonEmptyString(query) && !(model === 'jina-reranker-m0' && this.isImageDoc(query))) {
      return 'query must be non-empty text or a documented m0 image';
    }

    if (!Array.isArray(extra.documents) || extra.documents.length === 0) {
      return 'documents must be a non-empty array';
    }
    const documentsValid = extra.documents.every((document) =>
      this.isNonEmptyString(document) ||
      this.isTextDoc(document) ||
      (model === 'jina-reranker-m0' && this.isImageDoc(document)),
    );
    if (!documentsValid) return `documents contain an unsupported value for ${model}`;

    if (
      extra.topN !== undefined &&
      (!this.isIntegerInRange(extra.topN, 1, extra.documents.length))
    ) {
      return 'topN must be an integer between 1 and the number of documents';
    }
    const booleanError = this.validateBooleanOptions(extra, ['returnDocuments', 'truncation']);
    if (booleanError) return booleanError;

    if (model !== 'jina-reranker-v3') {
      if (extra.maxDocLength !== undefined || extra.returnEmbeddings !== undefined) {
        return 'maxDocLength and returnEmbeddings are v3-only';
      }
      return null;
    }

    if (
      extra.maxDocLength !== undefined &&
      !this.isIntegerInRange(extra.maxDocLength, 1, 8192)
    ) {
      return 'maxDocLength must be an integer between 1 and 8192';
    }
    if (extra.returnEmbeddings !== undefined && typeof extra.returnEmbeddings !== 'boolean') {
      return 'returnEmbeddings must be a boolean';
    }
    return null;
  }

  private validateEmbeddingInput(value: unknown, model: string): string | null {
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) return 'inputs must not be empty';
    if (values.some((item) => this.isPdfDoc(item))) {
      if (Array.isArray(value)) return 'PDF inputs must be sent individually';
      return model === 'jina-embeddings-v4' ? null : `${model} inputs do not support PDF`;
    }

    const valid = values.every(
      (item) =>
        this.isNonEmptyString(item) ||
        this.isTextDoc(item) ||
        (model === 'jina-embeddings-v4' && this.isImageDoc(item)),
    );
    return valid ? null : `inputs contain an unsupported value for ${model}`;
  }

  private validateBooleanOptions(
    extra: Record<string, unknown>,
    fields: string[],
  ): string | null {
    for (const field of fields) {
      if (extra[field] !== undefined && typeof extra[field] !== 'boolean') {
        return `${field} must be a boolean`;
      }
    }
    return null;
  }

  private isTextOnlyInput(value: unknown): boolean {
    const values = Array.isArray(value) ? value : [value];
    return values.every((item) => this.isNonEmptyString(item) || this.isTextDoc(item));
  }

  private isIntegerInRange(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
  }

  private isTextDoc(value: unknown): value is TextDoc {
    return this.isSingleStringFieldObject(value, 'text');
  }

  private isImageDoc(value: unknown): value is ImageDoc {
    return this.isSingleStringFieldObject(value, 'image');
  }

  private isPdfDoc(value: unknown): value is PdfDoc {
    return this.isSingleStringFieldObject(value, 'pdf');
  }

  private isSingleStringFieldObject(
    value: unknown,
    field: 'text' | 'image' | 'pdf',
  ): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 1 && this.isNonEmptyString(record[field]);
  }

  private invalidProviderResponse(
    json: JinaResponse,
    request: ConnectorRequest,
    errorMessage: string,
  ): ParsedApiOutput {
    return {
      text: '',
      model: typeof json.model === 'string' ? json.model : this.getModel(request),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: true,
      errorMessage,
    };
  }

  private validationError(request: ConnectorRequest, message: string): ConnectorResponse {
    return {
      id: randomUUID(),
      connector: this.name,
      model: this.getModel(request),
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: 0,
      queueWaitMs: 0,
      status: 'error',
      error: {
        type: 'validation_error',
        message,
        ...classifyErrorAction('validation_error'),
      },
    };
  }
}

import { randomUUID } from 'crypto';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ProviderModelMeta,
  classifyErrorAction,
} from '../interfaces/connector.interface';

type VoyageOperation = 'embeddings' | 'rerank';
type VoyageInputType = 'query' | 'document';
type VoyageOutputDtype = 'float' | 'int8' | 'uint8' | 'binary' | 'ubinary';

interface VoyageResponse {
  data?: unknown;
  model?: unknown;
  usage?: { total_tokens?: unknown };
}

const BASE_URL = 'https://api.voyageai.com/v1';
const DEFAULT_EMBEDDING_MODEL = 'voyage-4-large';
const DEFAULT_RERANK_MODEL = 'rerank-2.5';
const MAX_INPUTS = 1_000;

const EMBEDDING_MODELS = [
  'voyage-4-large',
  'voyage-4',
  'voyage-4-lite',
  'voyage-code-3',
  'voyage-finance-2',
  'voyage-law-2',
] as const;

const RERANK_MODELS = ['rerank-2.5', 'rerank-2.5-lite'] as const;

const FLEXIBLE_DIMENSION_MODELS = new Set([
  'voyage-4-large',
  'voyage-4',
  'voyage-4-lite',
  'voyage-3-large',
  'voyage-3.5',
  'voyage-3.5-lite',
  'voyage-code-3',
]);

const OUTPUT_DIMENSIONS = new Set([256, 512, 1024, 2048]);
const OUTPUT_DTYPES = new Set<VoyageOutputDtype>([
  'float',
  'int8',
  'uint8',
  'binary',
  'ubinary',
]);

/**
 * AU-023 public Voyage REST adapter.
 *
 * Frozen first-party contract (2026-07-15):
 * https://docs.voyageai.com/reference/embeddings-api.md
 * https://docs.voyageai.com/reference/reranker-api.md
 */
export class VoyageAiConnector extends BaseApiConnector {
  readonly name = 'voyage-ai';

  protected getBaseUrl(): string {
    return BASE_URL;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY ?? ''}`,
    };
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    const operation = this.getOperation(request);
    return `${this.getBaseUrl()}/${operation}`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    return this.getOperation(request) === 'rerank'
      ? this.buildRerankBody(request)
      : this.buildEmbeddingsBody(request);
  }

  protected parseResponse(json: VoyageResponse, request: ConnectorRequest): ParsedApiOutput {
    if (!Array.isArray(json.data)) {
      return this.invalidProviderResponse(json, request, 'Voyage response data must be an array');
    }

    const totalTokens = json.usage?.total_tokens;
    if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) {
      return this.invalidProviderResponse(
        json,
        request,
        'Voyage response usage.total_tokens must be a non-negative number',
      );
    }

    return {
      text: JSON.stringify(json.data),
      structured: json.data,
      model: typeof json.model === 'string' ? json.model : this.getModel(request),
      inputTokens: totalTokens,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }

  protected classifyHttpError(status: number, body: string): string {
    // Voyage documents 403 as a forbidden source IP, not invalid credentials.
    if (status === 403) return 'http_error';
    return super.classifyHttpError(status, body);
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const validationMessage = this.validateRequest(request);
    if (validationMessage) return this.validationError(request, validationMessage);

    const response = await super.execute(request);
    const apiKey = process.env.VOYAGE_API_KEY ?? '';
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

  private getOperation(request: ConnectorRequest): VoyageOperation {
    return request.extra?.operation === 'rerank' ? 'rerank' : 'embeddings';
  }

  private getModel(request: ConnectorRequest): string {
    return request.model ||
      (this.getOperation(request) === 'rerank' ? DEFAULT_RERANK_MODEL : DEFAULT_EMBEDDING_MODEL);
  }

  private buildEmbeddingsBody(request: ConnectorRequest): Record<string, unknown> {
    const extra = request.extra ?? {};
    const body: Record<string, unknown> = {
      input: extra.inputs ?? request.prompt,
      model: this.getModel(request),
    };

    this.copyDefined(body, 'input_type', extra.inputType);
    this.copyDefined(body, 'truncation', extra.truncation);
    this.copyDefined(body, 'output_dimension', extra.outputDimension);
    this.copyDefined(body, 'output_dtype', extra.outputDtype);
    this.copyDefined(body, 'encoding_format', extra.encodingFormat);
    return body;
  }

  private buildRerankBody(request: ConnectorRequest): Record<string, unknown> {
    const extra = request.extra ?? {};
    const body: Record<string, unknown> = {
      query: request.prompt,
      documents: extra.documents,
      model: this.getModel(request),
    };

    this.copyDefined(body, 'top_k', extra.topK);
    this.copyDefined(body, 'return_documents', extra.returnDocuments);
    this.copyDefined(body, 'truncation', extra.truncation);
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
    const extra = request.extra ?? {};
    if (extra.operation !== undefined && extra.operation !== 'embeddings' && extra.operation !== 'rerank') {
      return "operation must be 'embeddings' or 'rerank'";
    }
    if (typeof request.prompt !== 'string') return 'input query must be a string';

    if (this.getOperation(request) === 'rerank') return this.validateRerank(request);
    return this.validateEmbeddings(request);
  }

  private validateEmbeddings(request: ConnectorRequest): string | null {
    const extra = request.extra ?? {};
    const inputs = extra.inputs ?? request.prompt;
    const inputError = this.validateStringOrList(inputs, 'inputs');
    if (inputError) return inputError;

    if (
      extra.inputType !== undefined &&
      extra.inputType !== ('query' satisfies VoyageInputType) &&
      extra.inputType !== ('document' satisfies VoyageInputType)
    ) {
      return "inputType must be 'query' or 'document'";
    }
    if (extra.truncation !== undefined && typeof extra.truncation !== 'boolean') {
      return 'truncation must be a boolean';
    }
    if (extra.outputDimension !== undefined) {
      if (
        typeof extra.outputDimension !== 'number' ||
        !Number.isInteger(extra.outputDimension) ||
        !OUTPUT_DIMENSIONS.has(extra.outputDimension)
      ) {
        return 'outputDimension must be one of 256, 512, 1024, or 2048';
      }
      if (!FLEXIBLE_DIMENSION_MODELS.has(this.getModel(request))) {
        return `${this.getModel(request)} does not document flexible dimensions`;
      }
    }
    if (
      extra.outputDtype !== undefined &&
      (typeof extra.outputDtype !== 'string' ||
        !OUTPUT_DTYPES.has(extra.outputDtype as VoyageOutputDtype))
    ) {
      return 'outputDtype must be float, int8, uint8, binary, or ubinary';
    }
    if (
      extra.outputDtype !== undefined &&
      extra.outputDtype !== 'float' &&
      !FLEXIBLE_DIMENSION_MODELS.has(this.getModel(request))
    ) {
      return `${this.getModel(request)} does not document quantized outputDtype values`;
    }
    if (extra.encodingFormat !== undefined && extra.encodingFormat !== 'base64') {
      return "encodingFormat must be 'base64'";
    }
    return null;
  }

  private validateRerank(request: ConnectorRequest): string | null {
    const extra = request.extra ?? {};
    if (request.prompt.length === 0) return 'query must not be empty';
    const documentsError = this.validateStringList(extra.documents, 'documents');
    if (documentsError) return documentsError;
    const documents = extra.documents as string[];

    if (
      extra.topK !== undefined &&
      (typeof extra.topK !== 'number' ||
        !Number.isInteger(extra.topK) ||
        extra.topK < 1 ||
        extra.topK > documents.length)
    ) {
      return 'topK must be an integer between 1 and the number of documents';
    }
    if (extra.returnDocuments !== undefined && typeof extra.returnDocuments !== 'boolean') {
      return 'returnDocuments must be a boolean';
    }
    if (extra.truncation !== undefined && typeof extra.truncation !== 'boolean') {
      return 'truncation must be a boolean';
    }
    return null;
  }

  private validateStringOrList(value: unknown, field: string): string | null {
    if (typeof value === 'string') return value.length > 0 ? null : `${field} must not be empty`;
    return this.validateStringList(value, field);
  }

  private validateStringList(value: unknown, field: string): string | null {
    if (!Array.isArray(value)) return `${field} must be a non-empty string array`;
    if (value.length === 0) return `${field} must not be empty`;
    if (value.length > MAX_INPUTS) return `${field} must contain at most 1,000 strings`;
    if (value.some((item) => typeof item !== 'string' || item.length === 0)) {
      return `${field} must contain only non-empty strings`;
    }
    return null;
  }

  private invalidProviderResponse(
    json: VoyageResponse,
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

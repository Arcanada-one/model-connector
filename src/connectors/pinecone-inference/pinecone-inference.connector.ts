import { randomUUID } from 'crypto';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  classifyErrorAction,
} from '../interfaces/connector.interface';

const PINECONE_INFERENCE_BASE_URL = 'https://api.pinecone.io';
const PINECONE_API_VERSION = '2026-04';

type PineconeInferenceOperation = 'embed' | 'rerank';

interface PineconeEmbedResponse {
  model: string;
  vector_type: 'dense' | 'sparse';
  data: unknown[];
  usage: { total_tokens: number };
}

interface PineconeRerankResponse {
  model: string;
  data: Array<{ index: number; score: number; document?: Record<string, unknown> }>;
  usage: { rerank_units: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export class PineconeInferenceConnector extends BaseApiConnector {
  readonly name = 'pinecone-inference';

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) {
      return this.localError(request, 'auth_error', 'Pinecone API key is not configured');
    }

    const validationError = this.validateRequest(request);
    if (validationError) {
      return this.localError(request, 'validation_error', validationError);
    }

    const response = await super.execute(request);
    if (response.error?.message.includes(apiKey)) {
      response.error = {
        ...response.error,
        message: response.error.message.split(apiKey).join('[REDACTED]'),
      };
    }
    return response;
  }

  protected getBaseUrl(): string {
    return PINECONE_INFERENCE_BASE_URL;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Api-Key': process.env.PINECONE_API_KEY ?? '',
      'X-Pinecone-Api-Version': PINECONE_API_VERSION,
    };
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/${this.operation(request)}`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const extra = request.extra ?? {};
    if (this.operation(request) === 'embed') {
      const inputs = (extra.inputs as Array<Record<string, unknown>>).map((input) => ({
        text: input.text,
      }));
      const body: Record<string, unknown> = { model: request.model, inputs };
      if (extra.parameters !== undefined) body.parameters = { ...(extra.parameters as object) };
      return body;
    }

    const body: Record<string, unknown> = {
      model: request.model,
      query: extra.query,
      documents: (extra.documents as Array<Record<string, unknown>>).map((document) => ({
        ...document,
      })),
    };
    if (extra.top_n !== undefined) body.top_n = extra.top_n;
    if (extra.return_documents !== undefined) body.return_documents = extra.return_documents;
    if (extra.rank_fields !== undefined) body.rank_fields = [...(extra.rank_fields as string[])];
    if (extra.parameters !== undefined) body.parameters = { ...(extra.parameters as object) };
    return body;
  }

  protected parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const operation = this.operation(request);
    if (operation === 'embed') {
      if (!this.isEmbedResponse(json)) {
        return this.malformedResponse(request, 'embed');
      }
      return {
        text: '',
        structured: json,
        model: json.model,
        inputTokens: json.usage.total_tokens,
        outputTokens: 0,
        costUsd: 0,
        isError: false,
      };
    }

    if (!this.isRerankResponse(json)) {
      return this.malformedResponse(request, 'rerank');
    }
    return {
      text: '',
      structured: json,
      model: json.model,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: [],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 120_000,
    };
  }

  private operation(request: ConnectorRequest): PineconeInferenceOperation {
    return request.extra?.operation as PineconeInferenceOperation;
  }

  private validateRequest(request: ConnectorRequest): string | null {
    const extra = request.extra;
    if (extra?.operation !== 'embed' && extra?.operation !== 'rerank') {
      return "extra.operation must be 'embed' or 'rerank'";
    }
    if (!nonEmptyString(request.model)) return 'model is required';
    if (extra.parameters !== undefined && !isRecord(extra.parameters)) {
      return 'parameters must be an object';
    }

    if (extra.operation === 'embed') {
      if (!Array.isArray(extra.inputs) || extra.inputs.length === 0) {
        return 'embed inputs must be a non-empty array';
      }
      if (!extra.inputs.every((input) => isRecord(input) && nonEmptyString(input.text))) {
        return 'each embed input must contain non-empty text';
      }
      return null;
    }

    if (!nonEmptyString(extra.query)) return 'rerank query is required';
    if (
      !Array.isArray(extra.documents) ||
      extra.documents.length === 0 ||
      !extra.documents.every(isRecord)
    ) {
      return 'rerank documents must be a non-empty object array';
    }
    if (
      extra.top_n !== undefined &&
      (!Number.isInteger(extra.top_n) || (extra.top_n as number) < 1)
    ) {
      return 'top_n must be a positive integer';
    }
    if (extra.return_documents !== undefined && typeof extra.return_documents !== 'boolean') {
      return 'return_documents must be boolean';
    }
    if (
      extra.rank_fields !== undefined &&
      (!Array.isArray(extra.rank_fields) ||
        extra.rank_fields.length === 0 ||
        !extra.rank_fields.every(nonEmptyString))
    ) {
      return 'rank_fields must be a non-empty string array';
    }
    return null;
  }

  private isEmbedResponse(value: unknown): value is PineconeEmbedResponse {
    if (!isRecord(value) || !isRecord(value.usage)) return false;
    return (
      nonEmptyString(value.model) &&
      (value.vector_type === 'dense' || value.vector_type === 'sparse') &&
      Array.isArray(value.data) &&
      typeof value.usage.total_tokens === 'number' &&
      Number.isFinite(value.usage.total_tokens)
    );
  }

  private isRerankResponse(value: unknown): value is PineconeRerankResponse {
    if (!isRecord(value) || !isRecord(value.usage)) return false;
    return (
      nonEmptyString(value.model) &&
      Array.isArray(value.data) &&
      value.data.every(
        (entry) =>
          isRecord(entry) &&
          Number.isInteger(entry.index) &&
          typeof entry.score === 'number' &&
          Number.isFinite(entry.score) &&
          (entry.document === undefined || isRecord(entry.document)),
      ) &&
      typeof value.usage.rerank_units === 'number' &&
      Number.isFinite(value.usage.rerank_units)
    );
  }

  private malformedResponse(
    request: ConnectorRequest,
    operation: PineconeInferenceOperation,
  ): ParsedApiOutput {
    return {
      text: '',
      model: request.model ?? 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: true,
      errorMessage: `Malformed Pinecone ${operation} response`,
    };
  }

  private localError(request: ConnectorRequest, type: string, message: string): ConnectorResponse {
    return {
      id: randomUUID(),
      connector: this.name,
      model: request.model ?? 'unknown',
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: 0,
      queueWaitMs: 0,
      status: 'error',
      error: { type, message, ...classifyErrorAction(type) },
    };
  }
}

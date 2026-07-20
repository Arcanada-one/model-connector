import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

interface EmbeddingApiResponse {
  object: string;
  data: unknown[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

const ENDPOINT_PATHS: Record<string, string> = {
  dense: '/v1/embeddings',
  sparse: '/v1/embeddings/sparse',
  colbert: '/v1/embeddings/colbert',
  hybrid: '/v1/embeddings/hybrid',
};

export class EmbeddingConnector extends BaseApiConnector {
  readonly name = 'embedding';

  protected getBaseUrl(): string {
    return process.env.EMBEDDING_API_URL || 'http://100.70.137.104:8300';
  }

  protected getTimeout(): number {
    return Number(process.env.EMBEDDING_TIMEOUT_MS) || 30_000;
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    const type = (request.extra?.embeddingType as string) || 'dense';
    const path = ENDPOINT_PATHS[type] || ENDPOINT_PATHS.dense;
    return `${this.getBaseUrl()}${path}`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const texts = request.extra?.texts;
    const input = Array.isArray(texts) ? texts : request.prompt;
    return { input, model: request.model || 'bge-m3' };
  }

  protected parseResponse(json: EmbeddingApiResponse): ParsedApiOutput {
    return {
      text: JSON.stringify(json.data),
      structured: json.data,
      model: json.model || 'bge-m3',
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'embedding',
      type: 'api',
      models: ['bge-m3'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 60_000,
    };
  }
}

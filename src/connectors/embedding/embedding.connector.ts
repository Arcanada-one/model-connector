import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';
import { DEFAULT_EMBEDDING_API_URL } from '../../config/env.schema';

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
    // SEC-0045: the default comes from env.schema.ts, not a second literal.
    // Both copies had to be edited when the service moved and only one was, so
    // this connector went on dialling the decommissioned host.
    return process.env.EMBEDDING_API_URL || DEFAULT_EMBEDDING_API_URL;
  }

  /**
   * A2-207 — the one connector that deliberately does NOT fall back to the
   * global `CONNECTOR_TIMEOUT_MS`. Every other connector now takes it from
   * `BaseApiConnector.getTimeout()`; this one talks to our own embedding
   * service over the mesh, advertises `maxTimeout: 60_000` below, and sits on
   * Scrutator's indexing path, where a hang should surface in seconds rather
   * than hold a slot for two minutes. `EMBEDDING_TIMEOUT_MS` (declared in
   * .env.example at 30000) still overrides, through the base's derived key.
   */
  protected getTimeout(): number {
    const configured = Number(process.env.EMBEDDING_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : 30_000;
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
      modality: 'embedding',
      models: ['bge-m3'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 60_000,
    };
  }
}

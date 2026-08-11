import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

interface CloudflareEnvelope {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: {
    response?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  } | null;
}

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';

// Offline floor only. Cloudflare's authoritative account-scoped catalogue is
// GET /client/v4/accounts/{account_id}/ai/models/search (page/per_page are official).
// This connector deliberately performs no boot refresh: startup must not call a
// provider, and the endpoint spans non-chat task families that this adapter cannot run.
const TEXT_GENERATION_MODELS = [
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
];

export class CloudflareWorkersAiConnector extends BaseApiConnector {
  readonly name = 'cloudflare-workers-ai';

  protected getBaseUrl(): string {
    return process.env.CLOUDFLARE_WORKERS_AI_BASE_URL || 'https://api.cloudflare.com/client/v4';
  }

  protected getStaticModels(): string[] {
    return TEXT_GENERATION_MODELS;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CLOUDFLARE_WORKERS_AI_API_TOKEN || ''}`,
    };
  }

  protected getTimeout(): number {
    return Number(process.env.CLOUDFLARE_WORKERS_AI_TIMEOUT_MS) || 120_000;
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    const accountId = process.env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID || '';
    const model = request.model || DEFAULT_MODEL;
    return `${this.getBaseUrl()}/accounts/${accountId}/ai/run/${model}`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string') {
      throw new Error('cloudflare-workers-ai connector requires string prompt');
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = { messages };
    if (request.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    for (const key of ['max_tokens', 'temperature', 'top_p', 'top_k', 'seed'] as const) {
      if (request.extra?.[key] != null) body[key] = request.extra[key];
    }
    return body;
  }

  protected parseResponse(json: CloudflareEnvelope, request: ConnectorRequest): ParsedApiOutput {
    if (json.success === false || !json.result) {
      const detail = (json.errors ?? [])
        .map((error) => `${error.code ?? 'unknown'}: ${error.message ?? 'Cloudflare error'}`)
        .join('; ');
      return {
        text: '',
        model: request.model || DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: detail || 'Cloudflare Workers AI returned no result',
      };
    }
    const inputTokens = json.result.usage?.prompt_tokens ?? 0;
    const outputTokens = json.result.usage?.completion_tokens ?? 0;
    return {
      text: json.result.response ?? '',
      model: request.model || DEFAULT_MODEL,
      inputTokens,
      outputTokens,
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: this.dynamicModels,
      modelMeta: this.dynamicModelMetas.map((meta) => ({ ...meta, modality: 'chat' })),
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }
}

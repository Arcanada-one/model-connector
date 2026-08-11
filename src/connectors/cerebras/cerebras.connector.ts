import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
} from '../interfaces/connector.interface';

interface CerebrasChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const DEFAULT_MODEL = 'gpt-oss-120b';
const STATIC_MODELS = [DEFAULT_MODEL, 'zai-glm-4.7'];

export class CerebrasConnector extends BaseApiConnector {
  readonly name = 'cerebras';

  protected getBaseUrl(): string {
    return 'https://api.cerebras.ai/v1';
  }

  protected getStaticModels(): string[] {
    return STATIC_MODELS;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CEREBRAS_API_KEY ?? ''}`,
    };
  }

  protected getTimeout(): number {
    return Number(process.env.CEREBRAS_TIMEOUT_MS) || 120_000;
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/chat/completions`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string') {
      throw new Error('cerebras connector requires string prompt');
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = {
      model: request.model || DEFAULT_MODEL,
      messages,
    };
    if (request.extra?.max_completion_tokens != null) {
      body.max_completion_tokens = request.extra.max_completion_tokens;
    }
    if (request.extra?.temperature != null) body.temperature = request.extra.temperature;
    if (request.extra?.top_p != null) body.top_p = request.extra.top_p;
    return body;
  }

  protected parseResponse(json: CerebrasChatResponse, request: ConnectorRequest): ParsedApiOutput {
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return {
        text: '',
        model: json.model || request.model || DEFAULT_MODEL,
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No assistant content in Cerebras response',
      };
    }
    return {
      text: content,
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    const modelMeta = this.dynamicModelMetas;
    return {
      name: this.name,
      type: 'api',
      models: modelMeta.map((model) => model.id),
      modelMeta,
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 300_000,
    };
  }
}

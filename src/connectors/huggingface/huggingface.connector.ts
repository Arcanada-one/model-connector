import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

interface HuggingFaceChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const DEFAULT_MODEL = 'openai/gpt-oss-120b:fastest';

export class HuggingFaceConnector extends BaseApiConnector {
  readonly name = 'huggingface';

  protected getBaseUrl(): string { return 'https://router.huggingface.co/v1'; }
  protected getStaticModels(): string[] { return [DEFAULT_MODEL]; }
  protected getTimeout(): number { return Number(process.env.HUGGINGFACE_TIMEOUT_MS) || 120_000; }

  protected getHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HF_TOKEN || ''}` };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/chat/completions`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (typeof request.prompt !== 'string') throw new Error('huggingface connector requires string prompt');
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    const body: Record<string, unknown> = { model: request.model || DEFAULT_MODEL, messages };
    if (request.responseFormat?.type === 'json_object') body.response_format = { type: 'json_object' };
    for (const key of ['max_tokens', 'temperature', 'top_p'] as const) {
      if (request.extra?.[key] != null) body[key] = request.extra[key];
    }
    return body;
  }

  protected parseResponse(json: HuggingFaceChatResponse, request: ConnectorRequest): ParsedApiOutput {
    const choice = json.choices?.[0];
    if (!choice) return { text: '', model: json.model || request.model || DEFAULT_MODEL, inputTokens: 0, outputTokens: 0, costUsd: 0, isError: true, errorMessage: 'No choices in response' };
    return {
      text: choice.message?.content || '', model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0,
      costUsd: 0, isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return { name: this.name, type: 'api', models: [DEFAULT_MODEL], modelMeta: [{ id: DEFAULT_MODEL, modality: 'chat' }], modality: 'chat', supportsStreaming: false, supportsJsonSchema: false, supportsTools: false, maxTimeout: 300_000 };
  }
}

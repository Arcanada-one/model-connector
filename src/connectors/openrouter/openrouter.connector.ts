import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    total_cost?: number;
  };
}

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';

export class OpenRouterConnector extends BaseApiConnector {
  readonly name = 'openrouter';

  protected getBaseUrl(): string {
    return 'https://openrouter.ai/api';
  }

  protected getTimeout(): number {
    return Number(process.env.OPENROUTER_TIMEOUT_MS) || 120_000;
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/v1/chat/completions`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    const body: Record<string, unknown> = {
      model: request.model || DEFAULT_MODEL,
      messages,
    };

    if (request.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    if (request.extra?.max_tokens != null) {
      body.max_tokens = request.extra.max_tokens;
    }
    if (request.extra?.temperature != null) {
      body.temperature = request.extra.temperature;
    }
    if (request.extra?.top_p != null) {
      body.top_p = request.extra.top_p;
    }

    return body;
  }

  protected parseResponse(json: OpenRouterResponse, request: ConnectorRequest): ParsedApiOutput {
    const choice = json.choices?.[0];
    if (!choice) {
      return {
        text: '',
        model: json.model || request.model || DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No choices in response',
      };
    }

    return {
      text: choice.message.content || '',
      model: json.model || request.model || DEFAULT_MODEL,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      costUsd: json.usage?.total_cost ?? 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'openrouter',
      type: 'api',
      models: [
        'anthropic/claude-sonnet-4',
        'anthropic/claude-haiku-4',
        'openai/gpt-4o',
        'openai/gpt-4o-mini',
        'google/gemini-2.5-flash',
        'meta-llama/llama-4-maverick',
      ],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    };
  }
}

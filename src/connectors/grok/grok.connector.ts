import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

interface GrokChatResponse {
  id: string;
  object?: string;
  created?: number;
  model: string;
  choices: Array<{
    index?: number;
    message: { role: string; content: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  };
}

const DEFAULT_MODEL = 'grok-4-fast';

export class GrokConnector extends BaseApiConnector {
  readonly name = 'grok';

  protected getBaseUrl(): string {
    return 'https://api.x.ai';
  }

  protected getTimeout(): number {
    return Number(process.env.GROK_TIMEOUT_MS) || 120_000;
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = process.env.XAI_API_KEY || '';
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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
    // ARCA-0011: ContentBlock[] is rejected by the base-class guard
    // (`supportsContentBlocks=false`) before reaching this branch.
    if (typeof request.prompt !== 'string') {
      throw new Error('grok connector requires string prompt');
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

  protected parseResponse(json: GrokChatResponse, request: ConnectorRequest): ParsedApiOutput {
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
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'grok',
      type: 'api',
      models: [
        'grok-4-fast',
        'grok-4-fast-reasoning',
        'grok-4-fast-non-reasoning',
        'grok-4-1-fast-reasoning',
        'grok-4-1-fast-non-reasoning',
        'grok-4-0709',
        'grok-3',
        'grok-3-mini',
        'grok-code-fast-1',
      ],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
    };
  }
}

import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';
import { buildFreeModels } from './openmodel.catalogue';

interface OpenModelResponse {
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
  };
}

const DEFAULT_MODEL = 'deepseek-v4-flash';

export class OpenModelConnector extends BaseApiConnector {
  readonly name = 'openmodel';

  protected getBaseUrl(): string {
    return process.env.OPENMODEL_BASE_URL || 'https://api.openmodel.ai/v1';
  }

  protected getTimeout(): number {
    return Number(process.env.OPENMODEL_TIMEOUT_MS) || 30_000;
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = process.env.OPENMODEL_API_KEY || '';
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/chat/completions`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const messages: Array<{ role: string; content: string | typeof request.prompt }> = [];

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

    return body;
  }

  protected parseResponse(json: OpenModelResponse, request: ConnectorRequest): ParsedApiOutput {
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
      // Free tier — cost is always zero.
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities & { freeModels: string[] } {
    return {
      name: 'openmodel',
      type: 'api',
      models: ['deepseek-v4-flash', 'deepseek-r2', 'qwen3-235b'],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: false,
      maxTimeout: 120_000,
      freeModels: buildFreeModels(process.env.OPENMODEL_FREE_MODELS),
    };
  }
}

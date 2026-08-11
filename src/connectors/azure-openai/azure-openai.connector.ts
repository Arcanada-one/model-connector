import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ContentBlock,
} from '../interfaces/connector.interface';

interface AzureOpenAiResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export type AzureOpenAiTokenProvider = () => Promise<string>;

export interface AzureOpenAiConnectorOptions {
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  apiKey?: string;
  tokenProvider?: AzureOpenAiTokenProvider;
  headers?: Record<string, string>;
}

const DEFAULT_API_VERSION = '2024-10-21';

export class AzureOpenAiConnector extends BaseApiConnector {
  readonly name = 'azure-openai';

  constructor(private readonly options: AzureOpenAiConnectorOptions = {}) {
    super();
  }

  protected getBaseUrl(): string {
    return (this.options.endpoint || process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/$/, '');
  }

  protected getTimeout(): number {
    return Number(process.env.AZURE_OPENAI_TIMEOUT_MS) || 120_000;
  }

  protected get supportsContentBlocks(): boolean {
    return true;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.options.headers,
    };
  }

  protected async getRequestHeaders(_request: ConnectorRequest): Promise<Record<string, string>> {
    const apiKey = this.options.apiKey || process.env.AZURE_OPENAI_API_KEY;
    const tokenProvider = this.options.tokenProvider;
    if (apiKey && tokenProvider) {
      throw new Error('Azure OpenAI api-key and token provider are mutually exclusive');
    }
    if (tokenProvider) {
      return {
        ...this.getHeaders(),
        Authorization: `Bearer ${await tokenProvider()}`,
      };
    }
    if (!apiKey) {
      throw new Error('Azure OpenAI authentication requires an api-key or token provider');
    }
    return { ...this.getHeaders(), 'api-key': apiKey };
  }

  protected formatHttpErrorMessage(_status: number, body: string): string {
    try {
      const error = (JSON.parse(body) as { error?: { code?: unknown; message?: unknown } }).error;
      if (error && typeof error.message === 'string') {
        return typeof error.code === 'string' ? `${error.code}: ${error.message}` : error.message;
      }
    } catch {
      // Preserve the base connector's bounded plain-text behavior.
    }
    return super.formatHttpErrorMessage(_status, body);
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    const deployment = String(
      request.extra?.deployment ||
        this.options.deployment ||
        process.env.AZURE_OPENAI_DEPLOYMENT ||
        '',
    );
    const apiVersion = String(
      request.extra?.api_version ||
        this.options.apiVersion ||
        process.env.AZURE_OPENAI_API_VERSION ||
        DEFAULT_API_VERSION,
    );
    if (!this.getBaseUrl() || !deployment || !apiVersion) {
      throw new Error('Azure OpenAI endpoint, deployment, and api-version are required');
    }
    return `${this.getBaseUrl()}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    const messages: Array<{ role: string; content: string | ContentBlock[] }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });
    const body: Record<string, unknown> = { messages };
    if (request.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    for (const key of ['max_tokens', 'temperature', 'top_p', 'tools', 'tool_choice']) {
      if (request.extra?.[key] != null) body[key] = request.extra[key];
    }
    return body;
  }

  protected parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const response = json as AzureOpenAiResponse;
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return {
        text: '',
        model: response.model || request.model || 'azure-deployment',
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No chat completion choice in response',
      };
    }
    return {
      text: content,
      model: response.model || request.model || 'azure-deployment',
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      costUsd: 0,
      isError: false,
    };
  }

  getCapabilities(): ConnectorCapabilities {
    const deployment = this.options.deployment || process.env.AZURE_OPENAI_DEPLOYMENT;
    return {
      name: this.name,
      type: 'api',
      models: deployment ? [deployment] : [],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 300_000,
      modality: 'chat',
    };
  }
}

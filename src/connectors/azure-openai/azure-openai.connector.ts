import { redactProviderSecrets } from '../../policy/provider-key.context';
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

/**
 * Trusted physical Azure OpenAI request target used by protected prepare / P9.
 * Derived from the same fields `buildRequestUrl` uses. No secrets.
 * Account/environment is not a separate connector option today — the resource
 * is identified by `origin` (endpoint host).
 */
export interface AzureProtectedEffectiveTarget {
  kind: 'azure-openai';
  origin: string;
  deployment: string;
  apiVersion: string;
}

/**
 * Single configuration → target path shared by URL building and protected
 * reservation binding. Callers that must ignore request overrides pass
 * `requestExtra: null`.
 */
export function resolveAzureOpenAiRequestTarget(params: {
  endpoint?: string | null;
  deployment?: string | null;
  apiVersion?: string | null;
  requestExtra?: Record<string, unknown> | null;
}): AzureProtectedEffectiveTarget | null {
  const origin = String(params.endpoint || process.env.AZURE_OPENAI_ENDPOINT || '').replace(
    /\/$/,
    '',
  );
  const deployment = String(
    params.requestExtra?.deployment ||
      params.deployment ||
      process.env.AZURE_OPENAI_DEPLOYMENT ||
      '',
  );
  const apiVersion = String(
    params.requestExtra?.api_version ||
      params.apiVersion ||
      process.env.AZURE_OPENAI_API_VERSION ||
      DEFAULT_API_VERSION,
  );
  if (!origin || !deployment || !apiVersion) return null;
  return { kind: 'azure-openai', origin, deployment, apiVersion };
}

export function buildAzureOpenAiChatCompletionsUrl(target: AzureProtectedEffectiveTarget): string {
  return `${target.origin}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${encodeURIComponent(target.apiVersion)}`;
}

/** Parse the pre-built Azure chat-completions URL the connector is about to fetch. */
export function parseAzureOpenAiChatCompletionsUrl(
  url: string,
): AzureProtectedEffectiveTarget | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^(.*)\/openai\/deployments\/([^/]+)\/chat\/completions$/);
    if (!match) return null;
    const pathPrefix = match[1] ?? '';
    const deployment = decodeURIComponent(match[2] ?? '');
    const apiVersion = parsed.searchParams.get('api-version');
    if (!deployment || !apiVersion) return null;
    const origin = `${parsed.origin}${pathPrefix}`.replace(/\/$/, '');
    if (!origin) return null;
    return { kind: 'azure-openai', origin, deployment, apiVersion };
  } catch {
    return null;
  }
}

export function azureProtectedTargetsEqual(
  left: AzureProtectedEffectiveTarget,
  right: AzureProtectedEffectiveTarget,
): boolean {
  return (
    left.kind === right.kind &&
    left.origin === right.origin &&
    left.deployment === right.deployment &&
    left.apiVersion === right.apiVersion
  );
}

/** Embed the Azure effective target into the persisted protected route key. */
export function encodeAzureTargetIntoRouteKey(
  baseRouteKey: string,
  target: AzureProtectedEffectiveTarget,
): string {
  const fragment = [
    `azure-origin=${encodeURIComponent(target.origin)}`,
    `azure-deployment=${encodeURIComponent(target.deployment)}`,
    `azure-api-version=${encodeURIComponent(target.apiVersion)}`,
  ].join('&');
  return `${baseRouteKey}#${fragment}`;
}

/** Decode a previously bound Azure target from a protected route key. */
export function decodeAzureTargetFromRouteKey(
  routeKey: string,
): AzureProtectedEffectiveTarget | null {
  const hash = routeKey.indexOf('#');
  if (hash < 0) return null;
  const params = new URLSearchParams(routeKey.slice(hash + 1));
  const origin = params.get('azure-origin');
  const deployment = params.get('azure-deployment');
  const apiVersion = params.get('azure-api-version');
  if (!origin || !deployment || !apiVersion) return null;
  return { kind: 'azure-openai', origin, deployment, apiVersion };
}

export class AzureOpenAiConnector extends BaseApiConnector {
  readonly name = 'azure-openai';

  constructor(private readonly options: AzureOpenAiConnectorOptions = {}) {
    super();
  }

  protected getBaseUrl(): string {
    return (this.options.endpoint || process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/$/, '');
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
    body = redactProviderSecrets(body);
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

  /**
   * Same resolver `buildRequestUrl` uses. Protected prepare binds this identity
   * (with request.extra.deployment already refused) into the reservation.
   */
  resolveRequestTarget(request?: ConnectorRequest): AzureProtectedEffectiveTarget | null {
    return resolveAzureOpenAiRequestTarget({
      endpoint: this.options.endpoint,
      deployment: this.options.deployment,
      apiVersion: this.options.apiVersion,
      requestExtra: request?.extra ?? null,
    });
  }

  protected buildRequestUrl(request: ConnectorRequest): string {
    const target = this.resolveRequestTarget(request);
    if (!target) {
      throw new Error('Azure OpenAI endpoint, deployment, and api-version are required');
    }
    return buildAzureOpenAiChatCompletionsUrl(target);
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
    const deployment = this.getConfiguredDeployment();
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

  /**
   * Server-configured deployment only (options / env). Never reads
   * `request.extra.deployment` — that caller override is refused on the
   * protected profile so the priced catalogue model cannot diverge from the
   * URL path.
   *
   * LIMITATION: this returns the configured deployment *name*, not
   * provider-verified deployment metadata. Protected binding therefore trusts
   * operator configuration rather than an Azure-side model identity check.
   */
  getConfiguredDeployment(): string {
    return String(this.options.deployment || process.env.AZURE_OPENAI_DEPLOYMENT || '');
  }
}

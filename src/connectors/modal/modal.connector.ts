import { randomUUID } from 'node:crypto';
import {
  type CircuitBreakerResetEntry,
  type ConnectorCapabilities,
  type ConnectorRequest,
  type ConnectorResponse,
  type ConnectorStatus,
  type IConnector,
  classifyErrorAction,
} from '../interfaces/connector.interface';

export interface ModalEndpointConfig {
  endpointUrl: string;
  model: string;
  authMode: 'proxy' | 'none';
  proxyKey?: string;
  proxySecret?: string;
  timeoutMs: number;
}

export interface ModalTransportRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface ModalTransport {
  request(input: ModalTransportRequest): Promise<{ status: number; body: string }>;
}

class FetchModalTransport implements ModalTransport {
  async request(input: ModalTransportRequest): Promise<{ status: number; body: string }> {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  }
}

function environmentConfig(): ModalEndpointConfig {
  if (!process.env.MODAL_ENDPOINT_URL) {
    return {
      endpointUrl: 'https://unconfigured.invalid',
      model: 'unconfigured',
      authMode: 'none',
      timeoutMs: 120_000,
    };
  }
  const authMode: ModalEndpointConfig['authMode'] =
    process.env.MODAL_ENDPOINT_AUTH_MODE === 'none' ? 'none' : 'proxy';
  const config: ModalEndpointConfig = {
    endpointUrl: process.env.MODAL_ENDPOINT_URL ?? '',
    model: process.env.MODAL_ENDPOINT_MODEL ?? '',
    authMode,
    proxyKey: process.env.MODAL_PROXY_TOKEN_ID,
    proxySecret: process.env.MODAL_PROXY_TOKEN_SECRET,
    timeoutMs: Number(process.env.MODAL_ENDPOINT_TIMEOUT_MS) || 120_000,
  };
  validateConfig(config);
  return config;
}

function validateConfig(config: ModalEndpointConfig): void {
  const url = new URL(config.endpointUrl);
  if (url.protocol !== 'https:' || url.search || url.hash) {
    throw new Error('MODAL_ENDPOINT_URL must be an HTTPS base URL without query or fragment');
  }
  if (!config.model) throw new Error('MODAL_ENDPOINT_MODEL is required');
  if (config.authMode === 'proxy' && (!config.proxyKey?.trim() || !config.proxySecret?.trim())) {
    throw new Error('Modal proxy authentication requires both token ID and token secret');
  }
}

export class ModalConnector implements IConnector {
  readonly name = 'modal-endpoints';
  readonly type = 'api' as const;
  private models: string[];
  private readonly config: ModalEndpointConfig;
  private readonly transport: ModalTransport;

  constructor(config?: ModalEndpointConfig, transport: ModalTransport = new FetchModalTransport()) {
    this.config = config ?? environmentConfig();
    validateConfig(this.config);
    this.config.endpointUrl = this.config.endpointUrl.replace(/\/+$/, '');
    this.models = [this.config.model];
    this.transport = transport;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.authMode === 'proxy') {
      headers['Modal-Key'] = this.config.proxyKey!;
      headers['Modal-Secret'] = this.config.proxySecret!;
    }
    return headers;
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const id = randomUUID();
    const model = request.model ?? this.config.model;
    if (Array.isArray(request.prompt) || request.extra?.stream === true) {
      return this.error(id, model, 'validation_error', 'Modal Endpoints connector is synchronous');
    }
    const messages = [
      ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
      { role: 'user', content: request.prompt },
    ];
    const started = Date.now();
    try {
      const upstream = await this.transport.request({
        url: `${this.config.endpointUrl}/v1/chat/completions`,
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model, messages, stream: false }),
        timeoutMs: request.timeout ?? this.config.timeoutMs,
      });
      if (upstream.status < 200 || upstream.status >= 300) {
        const type =
          upstream.status === 401 || upstream.status === 403
            ? 'auth_error'
            : upstream.status === 429
              ? 'rate_limited'
              : upstream.status >= 500
                ? 'server_error'
                : 'validation_error';
        return this.error(id, model, type, upstream.body.slice(0, 500), Date.now() - started);
      }
      const json = JSON.parse(upstream.body) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const input = json.usage?.prompt_tokens ?? 0;
      const output = json.usage?.completion_tokens ?? 0;
      return {
        id,
        connector: this.name,
        model: json.model ?? model,
        result: json.choices?.[0]?.message?.content ?? '',
        usage: {
          inputTokens: input,
          outputTokens: output,
          totalTokens: input + output,
          costUsd: 0,
        },
        latencyMs: Date.now() - started,
        status: 'success',
      };
    } catch (cause) {
      const timeout = cause instanceof DOMException && cause.name === 'TimeoutError';
      return this.error(
        id,
        model,
        timeout ? 'timeout' : 'network_error',
        cause instanceof Error ? cause.message : String(cause),
        Date.now() - started,
      );
    }
  }

  async refreshModels(): Promise<void> {
    try {
      const upstream = await this.transport.request({
        url: `${this.config.endpointUrl}/v1/models`,
        method: 'GET',
        headers: this.headers(),
        timeoutMs: this.config.timeoutMs,
      });
      if (upstream.status < 200 || upstream.status >= 300) return;
      const data = (JSON.parse(upstream.body) as { data?: Array<{ id?: unknown }> }).data;
      const models = (data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (models.length > 0) this.models = models;
    } catch {
      // Discovery is advisory; retain the configured deployment identity.
    }
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: this.type,
      models: [...this.models],
      modelMeta: this.models.map((id) => ({ id, modality: 'chat' })),
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: this.config.timeoutMs,
      modality: 'chat',
    };
  }

  async getStatus(): Promise<ConnectorStatus> {
    return {
      name: this.name,
      healthy: true,
      activeJobs: 0,
      queuedJobs: 0,
      rateLimitStatus: 'ok',
    };
  }

  resetCircuitBreaker(): CircuitBreakerResetEntry[] {
    return [];
  }

  private error(
    id: string,
    model: string,
    type: string,
    message: string,
    latencyMs = 0,
  ): ConnectorResponse {
    const action = classifyErrorAction(type);
    return {
      id,
      connector: this.name,
      model,
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs,
      status: type === 'timeout' ? 'timeout' : type === 'rate_limited' ? 'rate_limited' : 'error',
      error: { type, message, ...action },
    };
  }
}

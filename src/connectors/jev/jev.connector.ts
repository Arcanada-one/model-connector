import { getProviderKeyOverride } from '../../policy/provider-key.context';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  CatalogRefreshResult,
  classifyErrorAction,
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
} from '../interfaces/connector.interface';
import { DecisionRequestSchema, nativeRequest, normalizeDecision } from './decision.contract';
import { DirectRoute, JevRouteEnv, jevRouteCatalogEntries } from './jev.routes';

/** Native System-One adapter. Disabled unless the operator explicitly enables it. */
export class JevConnector extends BaseApiConnector {
  readonly name = 'typesafe-jev';
  private readonly direct = new DirectRoute();

  private routeEnv(): JevRouteEnv {
    const override = getProviderKeyOverride(this.name)?.trim();
    return {
      TYPESAFE_API_KEY: override || process.env.TYPESAFE_API_KEY,
      TYPESAFE_JEV_API_KEY: process.env.TYPESAFE_JEV_API_KEY,
      TYPESAFE_JEV_DIRECT_BASE_URL: process.env.TYPESAFE_JEV_DIRECT_BASE_URL,
      TYPESAFE_JEV_ROUTES_ENABLED: process.env.TYPESAFE_JEV_ROUTES_ENABLED,
      CONNECTOR_VERSION: process.env.npm_package_version,
    };
  }

  private enabled(): boolean {
    // Re-read before every attempt: an in-process kill switch must not be cached.
    return process.env.JEV_ENABLED === 'true' && this.direct.assertConfigured(this.routeEnv()).ok;
  }

  protected getBaseUrl(): string {
    const url = this.direct.buildUrl(this.routeEnv());
    return url.replace(/\/v1\/systemone$/, '') || 'https://api.typesafe.ai';
  }
  protected buildRequestUrl(): string {
    return this.direct.buildUrl(this.routeEnv());
  }
  protected getRedirectPolicy(): RequestRedirect {
    return 'error';
  }
  protected getHeaders(): Record<string, string> {
    const headers = this.direct.headers(this.routeEnv());
    if ('ok' in headers) {
      return { 'Content-Type': 'application/json' };
    }
    return headers;
  }

  private async readBounded(response: Response): Promise<string> {
    const limit = 128 * 1024;
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('Unexpected oversized JEV response');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Unexpected empty JEV response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new Error('Unexpected oversized JEV response');
        chunks.push(part.value);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  protected async readResponseJson(response: Response): Promise<unknown> {
    return this.parseResponseJsonText(await this.readBounded(response));
  }

  protected readResponseError(response: Response): Promise<string> {
    return this.readBounded(response);
  }

  private readRequest(request: ConnectorRequest) {
    if (
      typeof request.prompt !== 'string' ||
      request.prompt.length > 100000 ||
      request.systemPrompt !== undefined ||
      request.tools !== undefined ||
      request.extra !== undefined ||
      request.jsonSchema !== undefined ||
      request.responseFormat !== undefined ||
      request.effort !== undefined ||
      request.maxTurns !== undefined ||
      (request.model !== undefined && request.model !== 'jev-latest')
    )
      throw new Error('invalid_request');
    const parsed = DecisionRequestSchema.safeParse(JSON.parse(request.prompt));
    if (!parsed.success) throw new Error('invalid_request');
    return parsed.data;
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    if (!this.enabled()) throw new Error('disabled');
    const decision = this.readRequest(request);
    // Live-direct path shape via JevRoute (CONN-JEV-02); nativeRequest stays the
    // DecisionRequest → {state,model,questions} adapter for provenance hashing.
    const native = nativeRequest(decision);
    return this.direct.buildBody(native.state, native.questions, native.model);
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    let reason: string | undefined;
    let errorType: string = 'validation_error';
    if (process.env.JEV_ENABLED !== 'true') {
      reason = 'disabled';
    } else if (!this.direct.assertConfigured(this.routeEnv()).ok) {
      // Empty direct key → route_not_configured without network (TZ §11.6).
      reason = 'route_not_configured';
      errorType = 'route_not_configured';
    } else {
      try {
        this.readRequest(request);
      } catch {
        reason = 'invalid_request';
      }
    }
    if (reason)
      return {
        id: randomUUID(),
        connector: this.name,
        model: 'unknown',
        result: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, usageMissing: true },
        latencyMs: 0,
        status: 'error',
        error: {
          type: errorType,
          message: `JEV ${reason}`,
          ...classifyErrorAction(errorType),
        },
      };
    const response = await super.execute(request);
    // Do not expose upstream bodies, JSON parse snippets or arbitrary transport messages.
    if (response.error)
      response.error = {
        ...response.error,
        message: `JEV ${response.error.type}`,
        details: undefined,
      };
    return response;
  }

  protected parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const decision = normalizeDecision(this.readRequest(request), json);
    // Preserve only bounded numeric usage metadata; never echo an arbitrary body.
    const usage = z
      .object({
        usage: z
          .record(z.string().max(64), z.number().nonnegative())
          .refine((v) => Object.keys(v).length <= 32),
      })
      .safeParse(json);
    const counts = usage.success ? usage.data.usage : undefined;
    const inputTokens = counts?.input_tokens;
    const outputTokens = counts?.output_tokens;
    const complete = Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens);
    return {
      text: '',
      structured: decision,
      model: decision.observedModel ?? 'unknown',
      inputTokens: complete ? inputTokens! : 0,
      outputTokens: complete ? outputTokens! : 0,
      costUsd: 0,
      ...(counts ? { providerUsage: counts } : {}),
      ...(!complete ? { usageMissing: true as const } : {}),
      isError: decision.status !== 'observed',
      errorMessage: 'JEV invalid_response',
    };
  }

  protected formatHttpErrorMessage(status: number): string {
    return `JEV HTTP ${status}`;
  }

  async getStatus(): Promise<ConnectorStatus> {
    if (this.enabled()) return super.getStatus();
    return { name: this.name, healthy: false, activeJobs: 0, queuedJobs: 0, rateLimitStatus: 'ok' };
  }

  // The audited provider contract contains no model-list endpoint. Do not invent one.
  async refreshModels(): Promise<CatalogRefreshResult> {
    return { status: 'failed', source: 'provider-api', checkedAt: new Date(), reason: 'empty' };
  }

  getCapabilities(): ConnectorCapabilities {
    // CONN-JEV-01 — publish the documented native model under modality=decision.
    // CONN-JEV-02 — executable catalog row remains direct `jev-latest` only.
    // OpenRouter/Cloudflare model ids stay on the JevRoute surface with
    // `available:false` until keyed (see `jevRouteCatalogEntries`); publishing
    // them here would invent catalog routability before CONN-JEV-05/09.
    const model = 'jev-latest';
    return {
      name: this.name,
      type: 'api',
      models: [model],
      modality: 'decision',
      modelMeta: [{ id: model, modality: 'decision' }],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 15000,
    };
  }

  /** Route-level availability rows (stubs report available:false). */
  routeCatalogEntries() {
    return jevRouteCatalogEntries(this.routeEnv());
  }
}

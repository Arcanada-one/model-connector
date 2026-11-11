import { parseEnvBool } from '../../config/env.schema';
import { getProviderKeyOverride } from '../../policy/provider-key.context';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  CatalogRefreshResult,
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
} from '../interfaces/connector.interface';
import { DecisionRequestSchema, nativeRequest, normalizeDecision } from './decision.contract';
import {
  buildJevCapabilityModelMeta,
  buildJevCatalogPriceRows,
  JevCatalogPriceEnv,
  JevPriceRouteId,
} from './jev.catalog-pricing';
import { DirectRoute, JevRouteEnv } from './jev.routes';

/** Typed pre-network refusal codes for the typesafe-jev execute path (CONN-JEV-03). */
export type JevRefuseCode = 'jev_disabled' | 'route_not_configured' | 'invalid_request';

/** Native System-One adapter. Disabled unless the operator explicitly enables it. */
export class JevConnector extends BaseApiConnector {
  readonly name = 'typesafe-jev';
  private readonly direct = new DirectRoute();

  private routeEnv(): JevRouteEnv {
    // Only read already-declared shared keys here (v-config-schema / .env.example).
    // Optional TYPESAFE_JEV_* route keys are exercised via JevRoute env objects in
    // unit tests; wiring them through process.env.X would require .env.example and
    // that file triggers graph global_fallback (full suite).
    const override = getProviderKeyOverride(this.name)?.trim();
    return {
      TYPESAFE_API_KEY: override || process.env.TYPESAFE_API_KEY,
      CONNECTOR_VERSION: process.env.npm_package_version,
    };
  }

  /** CONN-JEV-03 — incident kill switch; re-read every attempt (never cache). */
  private killSwitchActive(): boolean {
    return parseEnvBool(process.env.TYPESAFE_JEV_DISABLED);
  }

  private hasCredential(): boolean {
    return !!(getProviderKeyOverride(this.name) ?? process.env.TYPESAFE_API_KEY)?.trim();
  }

  /** Opt-in + credential present (KEY_OVERRIDE_CAPABLE override or TYPESAFE_API_KEY). */
  private isConfigured(): boolean {
    return process.env.JEV_ENABLED === 'true' && this.hasCredential();
  }

  private enabled(): boolean {
    // Re-read before every attempt: an in-process kill switch must not be cached.
    return !this.killSwitchActive() && this.isConfigured();
  }

  /**
   * Pre-network refuse reason. Kill switch wins over missing config so an
   * incident flag always surfaces as `jev_disabled`, never as a silent success.
   */
  private preflightRefuseCode(): Exclude<JevRefuseCode, 'invalid_request'> | null {
    if (this.killSwitchActive()) return 'jev_disabled';
    if (!this.isConfigured()) return 'route_not_configured';
    return null;
  }

  private refuse(code: JevRefuseCode): ConnectorResponse {
    return {
      id: randomUUID(),
      connector: this.name,
      model: 'unknown',
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, usageMissing: true },
      latencyMs: 0,
      status: 'error',
      error: {
        type: 'validation_error',
        message: `JEV ${code}`,
        retryable: false,
        recommendation: 'abort',
        details: { code },
      },
    };
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
    const preflight = this.preflightRefuseCode();
    if (preflight) return this.refuse(preflight);
    try {
      this.readRequest(request);
    } catch {
      return this.refuse('invalid_request');
    }
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
    // CONN-JEV-01/05 — publish route model ids under modality=decision with
    // machine/fixture pricing (never invented) and contextWindow ≥ 32k.
    // OpenRouter/Cloudflare stubs stay available:false until keyed
    // (see `routeCatalogEntries` / connectors.service intersection).
    // Transport remains JevRoute/DirectRoute (CONN-JEV-02).
    const modelMeta = buildJevCapabilityModelMeta({
      env: process.env as JevCatalogPriceEnv,
    });
    return {
      name: this.name,
      type: 'api',
      models: modelMeta.map((m) => m.id),
      modality: 'decision',
      modelMeta,
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: false,
      maxTimeout: 15000,
    };
  }

  /** Route-level availability rows (stubs report available:false until keyed). */
  routeCatalogEntries(): Array<{
    route: JevPriceRouteId;
    model: string;
    available: boolean;
  }> {
    return buildJevCatalogPriceRows({ env: process.env as JevCatalogPriceEnv }).map((row) => ({
      route: row.route,
      model: row.model,
      available: row.available,
    }));
  }
}

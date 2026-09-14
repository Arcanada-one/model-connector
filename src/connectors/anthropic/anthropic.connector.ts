import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BaseApiConnector, ParsedApiOutput } from '../base-api.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ContentBlock,
  classifyErrorAction,
  ProviderModelMeta,
} from '../interfaces/connector.interface';
import {
  MessagesApiValidationError,
  readMessagesApi,
  readPromptCacheFields,
} from '../../prompt-cache/messages-api';
import { getPromptCacheTenant } from '../../prompt-cache/prompt-cache.context';
import { PromptCachePolicyService } from '../../prompt-cache/prompt-cache-policy.service';

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * AUP-CACHE-003 / DEC-AUP-0028 — the Messages API `usage` object as documented
 * (platform.claude.com/docs prompt-caching, fetched 2026-09-13). `input_tokens`
 * is the UNCACHED TAIL (tokens after the last cache breakpoint); cache reads and
 * cache writes are reported separately and are ADDITIONAL to it. Every field is
 * optional here because the record of what the provider said is the verbatim
 * object, never this type.
 */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  [key: string]: unknown;
}

interface AnthropicMessageResponse {
  model?: string;
  content?: Array<AnthropicTextBlock | AnthropicToolUseBlock | { type: string }>;
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * DEC-AUP-0028 R4 — hand-curated list price per model, USD per 1M tokens, from
 * platform.claude.com/docs/en/about-claude/pricing (fetched 2026-09-13). The
 * catalogue carries only base input / output: cache-read (0.1×; 0.025× on
 * Fable / Mythos 5.1) and cache-write (1.25× 5m / 2× 1h) rates have no
 * catalogue column yet, so the ledger over-charges cache reads and
 * under-charges cache writes relative to the invoice. That gap is recorded as
 * `cache_rates: not_measured` in the admission receipt, never hidden. A model
 * outside this table stays UNPRICED (null) — the meter then records its tokens
 * as unpriced and charges nothing; an invented price would be worse than none.
 */
export const ANTHROPIC_LIST_PRICES_USD_PER_MTOK: Readonly<
  Record<string, { inputPerMTok: number; outputPerMTok: number }>
> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75 },
};
const PRICE_UNIT = 'USD/1M tokens';

const STATIC_MODELS = [
  'claude-fable-5-1',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-1',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

/** Attach the curated list price to a model meta; unknown ids keep `pricing: null`. */
function withListPrice(meta: ProviderModelMeta): ProviderModelMeta {
  const price = ANTHROPIC_LIST_PRICES_USD_PER_MTOK[meta.id];
  if (!price) return { ...meta, pricing: meta.pricing ?? null };
  return { ...meta, pricing: { ...price, unit: PRICE_UNIT } };
}

@Injectable()
export class AnthropicConnector extends BaseApiConnector {
  readonly name = 'anthropic';

  // AUP-CACHE-006 — the prompt-cache policy is optional so manual spec
  // constructions (`new AnthropicConnector()`) keep working unchanged; under
  // Nest DI the PromptCacheModule provides it.
  constructor(
    @Optional()
    @Inject(PromptCachePolicyService)
    private readonly promptCachePolicy?: PromptCachePolicyService,
  ) {
    super();
  }

  protected getBaseUrl(): string {
    return process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
  }

  protected getStaticModels(): string[] {
    return STATIC_MODELS;
  }

  /** DEC-AUP-0028 R4 — the offline floor carries the curated list price. */
  protected getStaticModelMetas(): ProviderModelMeta[] {
    return STATIC_MODELS.map((id) => withListPrice({ id }));
  }

  /**
   * DEC-AUP-0028 R4 — the live `/models` listing carries no prices (the
   * Anthropic models API reports ids/display names only), so a refresh would
   * otherwise REPLACE the priced floor with an unpriced list and the meter would
   * silently stop charging. Merge: live ids keep the curated price when one
   * exists; unknown live ids stay unpriced (null), never invented.
   */
  protected extractModels(json: unknown): ProviderModelMeta[] {
    return super.extractModels(json).map((meta) => withListPrice(meta));
  }

  protected getTimeout(): number {
    return Number(process.env.ANTHROPIC_TIMEOUT_MS) || 120_000;
  }

  protected get supportsContentBlocks(): boolean {
    return true;
  }

  protected getHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    };
  }

  protected buildRequestUrl(_request: ConnectorRequest): string {
    return `${this.getBaseUrl()}/messages`;
  }

  private mapContentBlock(block: ContentBlock): Record<string, unknown> {
    if (block.type === 'text') return block;

    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s.exec(block.image_url.url);
    if (!match) {
      throw new Error('Anthropic image prompts require a base64 data URL');
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: match[1], data: match[2] },
    };
  }

  protected buildRequestBody(request: ConnectorRequest): unknown {
    // AUP-CACHE-006 — raw Messages API passthrough (`extra.messages_api`):
    // the only way a caller can place cache_control breakpoints through CONN.
    // Allow-listed keys are copied verbatim; an unknown key is refused
    // (MessagesApiValidationError → validation_error), never dropped.
    const messagesApi = readMessagesApi(request.extra);
    if (messagesApi !== null) {
      return {
        model: request.model || DEFAULT_MODEL,
        max_tokens: (request.extra?.max_tokens as number | undefined) ?? DEFAULT_MAX_TOKENS,
        ...messagesApi,
      };
    }

    const content = Array.isArray(request.prompt)
      ? request.prompt.map((block) => this.mapContentBlock(block))
      : String(request.prompt);
    const body: Record<string, unknown> = {
      model: request.model || DEFAULT_MODEL,
      max_tokens: (request.extra?.max_tokens as number | undefined) ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content }],
    };

    if (request.systemPrompt) body.system = request.systemPrompt;
    if (request.extra?.temperature != null) body.temperature = request.extra.temperature;
    if (request.extra?.stop_sequences != null) body.stop_sequences = request.extra.stop_sequences;
    if (request.extra?.tools != null) body.tools = request.extra.tools;
    if (request.extra?.tool_choice != null) body.tool_choice = request.extra.tool_choice;
    return body;
  }

  /**
   * AUP-CACHE-006 — policy gate in front of the base execute path.
   *
   * The body is built exactly as it will be sent and handed to the policy with
   * the routing context (tenant = the calling API key, from
   * ConnectorsService.execute(); session identity from `extra.prompt_cache`).
   * `refuse` returns a typed `policy_violation` error carrying the decision —
   * non-retryable, so no failover hop repeats it. `mark`/`pass` continue into
   * the unchanged base path and the decision rides on the response
   * (`promptCachePolicy`, only for cache-claiming requests: a legacy request
   * keeps its byte-identical shape). The body is never modified.
   */
  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const policy = this.promptCachePolicy;
    let body: unknown;
    let fields;
    try {
      fields = readPromptCacheFields(request.extra);
      body = this.buildRequestBody(request);
    } catch (err) {
      if (err instanceof MessagesApiValidationError) {
        return this.refusal(request, 'validation_error', err.message);
      }
      // Any other build error (e.g. a remote image URL) keeps its existing
      // classification on the base path.
      return super.execute(request);
    }
    if (!policy || !policy.isActive()) return super.execute(request);

    const decision = policy.evaluate(body, {
      tenantId: getPromptCacheTenant(),
      sessionId: fields.session_id,
      sessionEpoch: fields.session_epoch,
      prefixHashClaimed: fields.prefix_hash,
    });
    if (decision === null) return super.execute(request);
    if (decision.action === 'refuse') {
      const codes = decision.findings
        .filter((f) => f.severity === 'error' || f.severity === 'refusal')
        .map((f) => `${f.code}@${f.layer}`);
      return this.refusal(
        request,
        'policy_violation',
        `Prompt-cache policy (${decision.contract.id}, enforce) refused the request: ${codes.join(', ')}. ` +
          'The gateway does not rewrite requests; fix the prefix or advance session_epoch explicitly.',
        decision,
      );
    }
    const response = await super.execute(request);
    if (decision.caching_claimed) response.promptCachePolicy = decision;
    return response;
  }

  private refusal(
    request: ConnectorRequest,
    type: 'validation_error' | 'policy_violation',
    message: string,
    details?: unknown,
  ): ConnectorResponse {
    return {
      id: randomUUID(),
      connector: this.name,
      model: request.model || 'unknown',
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: 0,
      queueWaitMs: 0,
      status: 'error',
      error: { type, message, details, ...classifyErrorAction(type) },
    };
  }

  protected parseResponse(json: unknown, request: ConnectorRequest): ParsedApiOutput {
    const response = json as AnthropicMessageResponse;
    const content = Array.isArray(response.content) ? response.content : [];
    const text = content
      .filter((block): block is AnthropicTextBlock => block.type === 'text' && 'text' in block)
      .map((block) => block.text)
      .join('\n');
    const toolCalls = content
      .filter(
        (block): block is AnthropicToolUseBlock =>
          block.type === 'tool_use' && 'id' in block && 'name' in block && 'input' in block,
      )
      .map(({ id, name, input }) => ({ id, name, input }));

    const usage = AnthropicConnector.mapUsage(response.usage);

    if (!text && toolCalls.length === 0) {
      return {
        text: '',
        model: response.model || request.model || DEFAULT_MODEL,
        ...usage,
        costUsd: 0,
        isError: true,
        errorMessage: 'No supported content blocks in response',
      };
    }

    return {
      text,
      structured:
        toolCalls.length > 0 ? { stopReason: response.stop_reason ?? null, toolCalls } : undefined,
      model: response.model || request.model || DEFAULT_MODEL,
      ...usage,
      costUsd: 0,
      isError: false,
    };
  }

  /**
   * AUP-CACHE-003 / DEC-AUP-0028 R3 — the honest mapping of Anthropic `usage`.
   *
   * Semantics trap: Anthropic's `input_tokens` is the uncached tail only;
   * `cache_read_input_tokens` and `cache_creation_input_tokens` are additional.
   * MC's `cachedInputTokens` is documented (and clamped by the meter) as a
   * SUBSET of `inputTokens`. So `inputTokens` here is the FULL input
   * (tail + writes + reads); reads go to `cachedInputTokens`; writes are
   * carried separately (billed 1.25× / 2×, never "cached"). The provider object
   * is copied verbatim as the record. No `usage` at all → `usageMissing: true`
   * with zero counts that are explicitly NOT measurements — the third verdict.
   */
  static mapUsage(
    usage: AnthropicUsage | undefined,
  ): Pick<
    ParsedApiOutput,
    | 'inputTokens'
    | 'outputTokens'
    | 'cachedInputTokens'
    | 'cacheCreationInputTokens'
    | 'cacheCreation'
    | 'providerUsage'
    | 'usageMissing'
  > {
    if (!usage || typeof usage !== 'object') {
      return { inputTokens: 0, outputTokens: 0, usageMissing: true };
    }
    const tail = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const read =
      typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined;
    const write =
      typeof usage.cache_creation_input_tokens === 'number'
        ? usage.cache_creation_input_tokens
        : undefined;
    const breakdown = usage.cache_creation;
    const cacheCreation =
      breakdown && typeof breakdown === 'object'
        ? {
            ...(typeof breakdown.ephemeral_5m_input_tokens === 'number'
              ? { ephemeral5mInputTokens: breakdown.ephemeral_5m_input_tokens }
              : {}),
            ...(typeof breakdown.ephemeral_1h_input_tokens === 'number'
              ? { ephemeral1hInputTokens: breakdown.ephemeral_1h_input_tokens }
              : {}),
          }
        : undefined;
    return {
      inputTokens: tail + (write ?? 0) + (read ?? 0),
      outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      ...(read !== undefined ? { cachedInputTokens: read } : {}),
      ...(write !== undefined ? { cacheCreationInputTokens: write } : {}),
      ...(cacheCreation !== undefined ? { cacheCreation } : {}),
      providerUsage: { ...usage },
    };
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: this.name,
      type: 'api',
      models: this.dynamicModels,
      modelMeta: this.dynamicModelMetas,
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: true,
      maxTimeout: 300_000,
      modality: 'chat',
    };
  }
}

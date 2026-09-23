import { BaseCliConnector, ParsedCliOutput } from '../base-cli.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** TTL breakdown of `cache_creation_input_tokens` (Claude Code >= 2.1). */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  [extra: string]: unknown;
}

interface ClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

interface ClaudeResultBase {
  type: 'result';
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: ClaudeUsage;
  modelUsage: Record<string, ClaudeModelUsage>;
  permission_denials: unknown[];
  session_id: string;
  uuid: string;
}

interface ClaudeResultSuccess extends ClaudeResultBase {
  subtype: 'success';
  is_error: false;
  result: string;
  structured_output?: unknown;
}

interface ClaudeResultError extends ClaudeResultBase {
  subtype:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries';
  is_error: true;
  errors: string[];
}

type ClaudeResult = ClaudeResultSuccess | ClaudeResultError;

const ERROR_SUBTYPE_MAP: Record<string, string> = {
  error_max_turns: 'max_turns_exceeded',
  error_max_budget_usd: 'budget_exceeded',
  error_max_structured_output_retries: 'structured_output_error',
  error_during_execution: 'execution_error',
};

/**
 * A2-P0-2-RES — which model served the request. The CLI's `modelUsage` map is
 * keyed by every model that ran inside the turn, and a Haiku side-call (a
 * small internal request the CLI makes on its own) can precede the requested
 * model in key order. `Object.keys(...)[0]` therefore attributed a
 * `claude-fable-5-1` request — and its whole ledger row — to Haiku
 * (measured on 2026-09-13: keys `['claude-haiku-4-5-20251001',
 * 'claude-fable-5-1']`, 897/11 tokens vs 2+10027+10835/4). The requested
 * model wins when it appears in the map; otherwise the entry that consumed
 * the most tokens (input + cache reads + cache writes + output); the first key
 * only as a last resort. `auto` is not a model id and never matches.
 */
export function pickServedModel(
  modelUsage: Record<string, ClaudeModelUsage> | undefined,
  requested: string | undefined,
): string {
  const entries = Object.entries(modelUsage ?? {});
  if (entries.length === 0) return 'claude-code';
  if (requested && requested !== 'auto' && modelUsage && requested in modelUsage) return requested;
  let best = entries[0];
  let bestTokens = -1;
  for (const entry of entries) {
    const u = entry[1] ?? ({} as Partial<ClaudeModelUsage>);
    const tokens =
      (u.inputTokens ?? 0) +
      (u.cacheReadInputTokens ?? 0) +
      (u.cacheCreationInputTokens ?? 0) +
      (u.outputTokens ?? 0);
    if (tokens > bestTokens) {
      best = entry;
      bestTokens = tokens;
    }
  }
  return best[0];
}

export class ClaudeCodeConnector extends BaseCliConnector {
  readonly name = 'claude-code';

  /**
   * A2-223 — a SUBSCRIPTION lane: `claude -p --output-format json` runs under the operator's Claude
   * subscription on this host; `total_cost_usd` in its reply is the API list
   * price of the same tokens, not an invoice. Measured 2026-09-23: 307 rows on
   * one host recorded $120.363277 of `costSource: 'provider'` charges this way
   * in ten days, and every one of them was written off as `uncollectible` once
   * the key's balance hit zero.
   *
   * Declared so `measureCostUsd` returns `costSource: 'subscription'` and
   * `usage.notionalCostUsd` instead of calling that figure a provider invoice.
   * `costUsd` itself is unchanged by the declaration — this names the money, it
   * does not move it.
   */
  readonly billingLane = 'subscription' as const;

  protected getBinaryPath(): string {
    return process.env.CLAUDE_BINARY_PATH || 'claude';
  }

  protected buildArgs(request: ConnectorRequest): string[] {
    const args = ['-p', '--output-format', 'json'];

    const extra = request.extra ?? {};
    const permissionMode =
      typeof extra.permissionMode === 'string' ? extra.permissionMode : 'bypassPermissions';
    args.push('--permission-mode', permissionMode);

    if (request.model && request.model !== 'auto') {
      args.push('--model', request.model);
    }

    const systemPrompt = this.buildSystemPromptWithJsonMode(request);
    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    if (request.maxTurns != null) {
      args.push('--max-turns', String(request.maxTurns));
    }

    if (request.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(request.maxBudgetUsd));
    }

    if (request.effort) {
      args.push('--effort', request.effort);
    }

    if (request.jsonSchema) {
      args.push('--json-schema', JSON.stringify(request.jsonSchema));
    }

    if (typeof extra.allowedTools === 'string') {
      args.push('--allowed-tools', extra.allowedTools);
    }

    if (typeof extra.disallowedTools === 'string') {
      args.push('--disallowed-tools', extra.disallowedTools);
    }

    if (typeof extra.fallbackModel === 'string') {
      args.push('--fallback-model', extra.fallbackModel);
    }

    if (typeof extra.thinking === 'string') {
      args.push('--thinking', extra.thinking);
    }

    if (typeof extra.addDir === 'string') {
      args.push('--add-dir', extra.addDir);
    }

    // ARCA-0011: ContentBlock[] rejected by base-class guard before reaching
    // this code path.
    if (typeof request.prompt !== 'string') {
      throw new Error('claude-code connector requires string prompt');
    }
    args.push(request.prompt);
    return args;
  }

  protected parseOutput(
    stdout: string,
    stderr: string,
    request?: ConnectorRequest,
  ): ParsedCliOutput {
    const trimmed = stdout.trim();

    if (!trimmed) {
      return {
        text: '',
        model: 'claude-code',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: stderr.replace(/\x1b\[[0-9;]*m/g, '').trim() || 'No output',
      };
    }

    let json: ClaudeResult;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return {
        text: trimmed,
        model: 'claude-code',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'Failed to parse Claude Code JSON output',
      };
    }

    const model = pickServedModel(json.modelUsage, request?.model);
    const costUsd = json.total_cost_usd ?? 0;
    // AUP-CACHE-003 / DEC-AUP-0028 R3 (A3: the CLI lane) — the CLI's `usage`
    // is the Anthropic Messages usage object: `input_tokens` is the UNCACHED
    // tail, not the whole prompt. Reading it as the total made
    // `cachedInputTokens` (a declared subset of `inputTokens`) larger than
    // `inputTokens` on every cache hit. Full input = tail + cache writes +
    // cache reads; reads stay the only thing `cachedInputTokens` means; writes
    // ride separately because they carry their own tariff (1.25x / 2x, never
    // the read rate); the raw object is copied verbatim as the record; no
    // `usage` at all is reported as `usageMissing: true`, never as zeros.
    const usage = json.usage;
    const usageMissing = usage === undefined || usage === null;
    const tail = usage?.input_tokens ?? 0;
    const read = usage?.cache_read_input_tokens;
    const write = usage?.cache_creation_input_tokens;
    const inputTokens = usageMissing ? 0 : tail + (write ?? 0) + (read ?? 0);
    const outputTokens = usage?.output_tokens ?? 0;
    const cachedInputTokens = usageMissing ? undefined : (read ?? 0);
    const ttl = usage?.cache_creation;
    const cacheCreation =
      ttl &&
      (ttl.ephemeral_5m_input_tokens !== undefined || ttl.ephemeral_1h_input_tokens !== undefined)
        ? {
            ...(ttl.ephemeral_5m_input_tokens !== undefined
              ? { ephemeral5mInputTokens: ttl.ephemeral_5m_input_tokens }
              : {}),
            ...(ttl.ephemeral_1h_input_tokens !== undefined
              ? { ephemeral1hInputTokens: ttl.ephemeral_1h_input_tokens }
              : {}),
          }
        : undefined;
    const passthrough = usageMissing
      ? { usageMissing: true as const }
      : {
          ...(write !== undefined ? { cacheCreationInputTokens: write } : {}),
          ...(cacheCreation !== undefined ? { cacheCreation } : {}),
          providerUsage: { ...usage } as Record<string, unknown>,
        };

    const meta: Record<string, unknown> = {
      sessionId: json.session_id,
      uuid: json.uuid,
      numTurns: json.num_turns,
      durationMs: json.duration_ms,
      durationApiMs: json.duration_api_ms,
      stopReason: json.stop_reason,
      permissionDenials: json.permission_denials,
    };

    if (json.is_error) {
      const errorJson = json as ClaudeResultError;
      return {
        text: '',
        structured: meta,
        model,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        ...passthrough,
        costUsd,
        isError: true,
        errorType: ERROR_SUBTYPE_MAP[errorJson.subtype] || 'execution_error',
        errorMessage: errorJson.errors?.join('; ') || errorJson.subtype,
      };
    }

    const successJson = json as ClaudeResultSuccess;
    if (successJson.structured_output !== undefined) {
      meta.structuredOutput = successJson.structured_output;
    }

    return {
      text: successJson.result,
      structured: meta,
      model,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      ...passthrough,
      costUsd,
      isError: false,
    };
  }

  protected classifyError(message: string, exitCode: number): string {
    const lower = message.toLowerCase();
    if (lower.includes('billing_error') || lower.includes('credit balance')) {
      return 'billing_error';
    }
    if (lower.includes('authentication_failed')) {
      return 'auth_error';
    }
    if (lower.includes('max_output_tokens')) {
      return 'max_output_tokens';
    }
    return super.classifyError(message, exitCode);
  }

  protected getEnv(request: ConnectorRequest): Record<string, string> {
    const env: Record<string, string> = {};
    if (typeof request.extra?.apiKey === 'string') {
      env.ANTHROPIC_API_KEY = request.extra.apiKey;
    }
    return env;
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'claude-code',
      type: 'cli',
      models: [
        // Claude 5 line — measured answering through `claude -p` on 2026-09-13
        // (A2-P0-2-RES); the 4.x ids stay for callers that still name them.
        'claude-fable-5-1',
        'claude-opus-5',
        'claude-sonnet-5',
        'claude-haiku-4-5-20251001',
        'claude-sonnet-4-6',
        'claude-opus-4-6',
        'claude-haiku-4-5',
        'sonnet',
        'opus',
        'haiku',
      ],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 600_000,
    };
  }
}

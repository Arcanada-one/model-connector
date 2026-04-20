import { BaseCliConnector, ParsedCliOutput } from '../base-cli.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
} from '../interfaces/connector.interface';

interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
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

export class ClaudeCodeConnector extends BaseCliConnector {
  readonly name = 'claude-code';

  protected getBinaryPath(): string {
    return process.env.CLAUDE_BINARY_PATH || 'claude';
  }

  protected buildArgs(request: ConnectorRequest): string[] {
    const args = ['-p', '--output-format', 'json'];

    const extra = request.extra ?? {};
    const permissionMode =
      typeof extra.permissionMode === 'string'
        ? extra.permissionMode
        : 'bypassPermissions';
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

    args.push(request.prompt);
    return args;
  }

  protected parseOutput(stdout: string, stderr: string): ParsedCliOutput {
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

    const model = Object.keys(json.modelUsage)[0] || 'claude-code';
    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
    const costUsd = json.total_cost_usd ?? 0;

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

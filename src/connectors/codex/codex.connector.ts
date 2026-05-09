import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { BaseCliConnector, ParsedCliOutput } from '../base-cli.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';
import { normalizeSchema } from './schema-normalizer';

interface CodexEvent {
  type: string;
  thread_id?: string;
  message?: { id?: string; role?: string; content?: string };
  delta?: { content?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
  item?: { id?: string; type?: string; message?: string };
}

const DEFAULT_MODEL = 'o4-mini';
const SCHEMA_TMP_DIR = join(tmpdir(), 'codex-schemas');

export class CodexConnector extends BaseCliConnector {
  readonly name = 'codex';

  protected getBinaryPath(): string {
    return process.env.CODEX_BINARY_PATH || 'codex';
  }

  protected buildArgs(request: ConnectorRequest): string[] {
    const model = request.model || DEFAULT_MODEL;
    const prompt = this.buildPromptWithJsonMode(request);
    const args = [
      'exec',
      '--model',
      model,
      '--json',
      '--full-auto',
      '--ephemeral',
      '--skip-git-repo-check',
    ];
    if (request.jsonSchema) {
      const schemaPath = this.writeTempSchema(request.jsonSchema);
      args.push('--output-schema', schemaPath);
    }
    args.push(prompt);
    return args;
  }

  protected writeTempSchema(schema: Record<string, unknown>): string {
    const normalized = normalizeSchema(schema);
    mkdirSync(SCHEMA_TMP_DIR, { recursive: true, mode: 0o700 });
    const path = join(SCHEMA_TMP_DIR, `${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(normalized), { mode: 0o600 });
    return path;
  }

  protected parseOutput(stdout: string, stderr: string): ParsedCliOutput {
    const trimmed = stdout.trim();

    if (!trimmed) {
      return {
        text: '',
        model: DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: this.extractStderrError(stderr) || 'No output',
      };
    }

    const events = this.parseJsonl(trimmed);

    if (events.length === 0) {
      return {
        text: '',
        model: DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: this.extractStderrError(stderr) || 'Failed to parse Codex JSONL output',
      };
    }

    const threadId = events.find((e) => e.type === 'thread.started')?.thread_id;
    const fatalError = events.find((e) => e.type === 'error');
    const turnFailed = events.find((e) => e.type === 'turn.failed');
    const messageCompleted = events.find((e) => e.type === 'message.completed');
    const turnCompleted = events.find((e) => e.type === 'turn.completed');

    const errorEvent = fatalError || turnFailed;
    const hasSuccessMessage = !!messageCompleted?.message?.content;

    if (errorEvent && !hasSuccessMessage) {
      const errorMsg = fatalError?.message ?? turnFailed?.error?.message ?? 'Unknown Codex error';
      return {
        text: '',
        structured: threadId ? { threadId } : undefined,
        model: DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: typeof errorMsg === 'string' ? errorMsg : String(errorMsg),
      };
    }

    const text = messageCompleted?.message?.content ?? '';
    const usage = turnCompleted?.usage;

    if (!text) {
      return {
        text: '',
        structured: threadId ? { threadId } : undefined,
        model: DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No message in Codex response',
      };
    }

    const cachedInputTokens = usage?.cached_input_tokens ?? 0;
    const reasoningOutputTokens = usage?.reasoning_output_tokens ?? 0;
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;

    const structured: Record<string, unknown> = {};
    if (threadId) structured.threadId = threadId;
    if (cachedInputTokens > 0) structured.cachedInputTokens = cachedInputTokens;
    if (reasoningOutputTokens > 0) {
      structured.reasoningOutputTokens = reasoningOutputTokens;
      structured.totalTokens = inputTokens + outputTokens + reasoningOutputTokens;
    }

    return {
      text,
      structured: Object.keys(structured).length > 0 ? structured : undefined,
      model: DEFAULT_MODEL,
      inputTokens,
      outputTokens,
      costUsd: 0,
      isError: false,
    };
  }

  private parseJsonl(raw: string): CodexEvent[] {
    const events: CodexEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as CodexEvent);
      } catch {
        // Skip non-JSON lines (Rust tracing logs, etc.)
      }
    }
    return events;
  }

  protected classifyError(message: string, exitCode: number): string {
    const lower = message.toLowerCase();
    if (
      lower.includes('refresh token') ||
      lower.includes('token is expired') ||
      lower.includes('sign in again') ||
      lower.includes('authentication token')
    ) {
      return 'auth_error';
    }
    if (lower.includes('model metadata') && lower.includes('not found')) {
      return 'model_not_found';
    }
    if (lower.includes('output schema') && lower.includes('not valid json')) {
      return 'validation_error';
    }
    if (
      /credit_depleted|credits?\b.{0,20}(exhaust|deplet)|out of credit|quota\b.{0,15}(exhaust|exceed)/i.test(
        message,
      )
    ) {
      return 'credit_depleted';
    }
    return super.classifyError(message, exitCode);
  }

  private extractStderrError(stderr: string): string {
    const lines = stderr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('Reading additional input'));
    return lines.join(' ').slice(0, 500);
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'codex',
      type: 'cli',
      models: ['o4-mini', 'o3', 'codex-mini-latest'],
      supportsStreaming: false,
      supportsJsonSchema: true,
      supportsTools: true,
      maxTimeout: 600_000,
    };
  }
}

import { BaseCliConnector, ParsedCliOutput } from '../base-cli.connector';
import { ConnectorCapabilities, ConnectorRequest } from '../interfaces/connector.interface';

interface CodexEvent {
  type: string;
  thread_id?: string;
  message?: { id?: string; role?: string; content?: string };
  delta?: { content?: string };
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { message?: string };
  item?: { id?: string; type?: string; message?: string };
}

const DEFAULT_MODEL = 'o4-mini';

export class CodexConnector extends BaseCliConnector {
  readonly name = 'codex';

  protected getBinaryPath(): string {
    return process.env.CODEX_BINARY_PATH || 'codex';
  }

  protected buildArgs(request: ConnectorRequest): string[] {
    const model = request.model || DEFAULT_MODEL;
    const prompt = this.buildPromptWithJsonMode(request);
    return [
      'exec',
      '--model',
      model,
      '--json',
      '--full-auto',
      '--ephemeral',
      '--skip-git-repo-check',
      prompt,
    ];
  }

  protected parseOutput(stdout: string, _stderr: string): ParsedCliOutput {
    const trimmed = stdout.trim();

    if (!trimmed) {
      return {
        text: '',
        model: DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'No output',
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
        errorMessage: 'Failed to parse Codex JSONL output',
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

    // No message and no error = incomplete response
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

    return {
      text,
      structured: threadId ? { threadId } : undefined,
      model: DEFAULT_MODEL,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
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
    return super.classifyError(message, exitCode);
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'codex',
      type: 'cli',
      models: ['o4-mini', 'o3', 'codex-mini-latest'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: true,
      maxTimeout: 600_000,
    };
  }
}

import { BaseCliConnector, ParsedCliOutput } from '../base-cli.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
} from '../interfaces/connector.interface';

interface CursorJsonResult {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  result: string;
  session_id: string;
  request_id: string;
}

export class CursorConnector extends BaseCliConnector {
  readonly name = 'cursor';

  protected getBinaryPath(): string {
    return process.env.CURSOR_BINARY_PATH || 'cursor-agent';
  }

  protected buildArgs(request: ConnectorRequest): string[] {
    const args = ['--print', '--output-format', 'json', '--force'];

    if (request.model) {
      args.push('--model', request.model);
    }

    const extra = request.extra ?? {};

    if (typeof extra.mode === 'string') {
      args.push('--mode', extra.mode);
    }

    if (typeof extra.workspace === 'string') {
      args.push('--workspace', extra.workspace);
    }

    args.push(request.prompt);
    return args;
  }

  protected parseOutput(stdout: string, stderr: string): ParsedCliOutput {
    const trimmed = stdout.trim();

    if (!trimmed) {
      return {
        text: '',
        model: 'cursor-auto',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: stderr.replace(/\x1b\[[0-9;]*m/g, '').trim() || 'No output',
      };
    }

    try {
      const json = JSON.parse(trimmed) as CursorJsonResult;
      return {
        text: json.result,
        structured: {
          sessionId: json.session_id,
          requestId: json.request_id,
          durationMs: json.duration_ms,
        },
        model: 'cursor-auto',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: json.is_error || json.subtype === 'error',
        errorMessage: json.is_error ? json.result : undefined,
      };
    } catch {
      return {
        text: trimmed,
        model: 'cursor-auto',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'Failed to parse Cursor JSON output',
      };
    }
  }

  protected getEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (process.env.CURSOR_API_KEY) {
      env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
    }
    return env;
  }

  protected classifyError(message: string, exitCode: number): string {
    const lower = message.toLowerCase();
    if (lower.includes('authentication required') || lower.includes('api key is invalid')) {
      return 'auth_error';
    }
    return super.classifyError(message, exitCode);
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'cursor',
      type: 'cli',
      models: ['cursor-auto', 'gpt-5', 'sonnet-4', 'sonnet-4-thinking'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: true,
      maxTimeout: 600_000,
    };
  }
}

import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { BaseCliConnector, ParsedCliOutput, SpawnResult } from '../base-cli.connector';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
} from '../interfaces/connector.interface';
import { randomUUID } from 'crypto';

interface GeminiTokenStats {
  input: number;
  prompt: number;
  candidates: number;
  total: number;
  cached: number;
  thoughts: number;
  tool: number;
}

interface GeminiModelStats {
  api: { totalRequests: number; totalErrors: number; totalLatencyMs: number };
  tokens: GeminiTokenStats;
}

interface GeminiSuccessResult {
  session_id: string;
  response: string;
  stats: {
    models: Record<string, GeminiModelStats>;
    tools: { totalCalls: number };
    files: { totalLinesAdded: number; totalLinesRemoved: number };
  };
}

interface GeminiErrorResult {
  session_id: string;
  error: { type: string; message: string; code: number };
}

type GeminiResult = GeminiSuccessResult | GeminiErrorResult;

const DEFAULT_MODEL = 'gemini-2.5-flash';

export class GeminiConnector extends BaseCliConnector {
  readonly name = 'gemini';

  protected getBinaryPath(): string {
    return process.env.GEMINI_BINARY_PATH || 'gemini';
  }

  protected buildArgs(request: ConnectorRequest): string[] {
    const model = request.model || DEFAULT_MODEL;
    const args = ['-p', request.prompt, '-m', model, '--output-format', 'json'];

    const extra = request.extra ?? {};

    if (extra.sandbox === true) {
      args.push('--sandbox');
    }

    return args;
  }

  protected parseOutput(stdout: string, stderr: string): ParsedCliOutput {
    const trimmed = stdout.trim();

    // Error path: stdout empty, try extracting JSON from stderr
    if (!trimmed) {
      return this.parseFromStderr(stderr);
    }

    // Success path: parse JSON from stdout
    let json: GeminiResult;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return {
        text: trimmed,
        model: DEFAULT_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        isError: true,
        errorMessage: 'Failed to parse Gemini JSON output',
      };
    }

    if ('error' in json) {
      return this.buildErrorOutput(json as GeminiErrorResult);
    }

    return this.buildSuccessOutput(json as GeminiSuccessResult);
  }

  private parseFromStderr(stderr: string): ParsedCliOutput {
    const cleaned = stderr.trim();
    if (!cleaned) {
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

    // Extract last JSON object from stderr by trying progressively earlier '{' positions
    const lines = cleaned.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{')) {
        const candidate = lines.slice(i).join('\n');
        try {
          const json = JSON.parse(candidate) as GeminiErrorResult;
          if (json.error) {
            return this.buildErrorOutput(json);
          }
        } catch {
          // Not valid JSON starting here, try earlier line
        }
      }
    }

    return {
      text: '',
      model: DEFAULT_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: true,
      errorMessage: this.filterIdeNoise(cleaned).slice(0, 500) || 'Unknown error',
    };
  }

  private buildSuccessOutput(json: GeminiSuccessResult): ParsedCliOutput {
    const modelEntries = Object.entries(json.stats?.models ?? {});
    const model = modelEntries[0]?.[0] || DEFAULT_MODEL;
    const tokens = modelEntries[0]?.[1]?.tokens;

    const response = this.stripMarkdownWrapper(json.response ?? '');

    return {
      text: response,
      structured: { sessionId: json.session_id },
      model,
      inputTokens: tokens?.input ?? 0,
      outputTokens: tokens?.candidates ?? 0,
      costUsd: 0, // Gemini CLI does not report cost
      isError: false,
    };
  }

  private buildErrorOutput(json: GeminiErrorResult): ParsedCliOutput {
    return {
      text: '',
      structured: { sessionId: json.session_id },
      model: DEFAULT_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      isError: true,
      errorMessage: json.error.message,
    };
  }

  private stripMarkdownWrapper(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
      const firstNewline = trimmed.indexOf('\n');
      if (firstNewline > 0) {
        return trimmed.slice(firstNewline + 1, trimmed.length - 3).trim();
      }
    }
    return text;
  }

  private filterIdeNoise(stderr: string): string {
    return stderr
      .split('\n')
      .filter((line) => !line.includes('[IDEClient]') && !line.includes('Loaded cached credentials'))
      .join('\n')
      .trim();
  }

  protected classifyError(message: string, exitCode: number): string {
    const lower = message.toLowerCase();
    if (lower.includes('exhausted') || lower.includes('capacity') || lower.includes('quota')) {
      return 'rate_limited';
    }
    if (lower.includes('not found') || lower.includes('404')) {
      return 'model_not_found';
    }
    return super.classifyError(message, exitCode);
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    const id = randomUUID();
    const timeout = request.timeout ?? 300_000;
    const start = Date.now();

    // CWD isolation: spawn from temp dir to prevent workspace scanning
    const cwdPath = await mkdtemp(join(tmpdir(), 'gemini_'));

    this.activeJobs++;
    try {
      const { stdout, stderr, exitCode } = await this.spawnWithCwd(
        this.getBinaryPath(),
        this.buildArgs(request),
        timeout,
        this.getEnv(request),
        cwdPath,
      );

      const latencyMs = Date.now() - start;
      const parsed = this.parseOutput(stdout, stderr);

      const base: ConnectorResponse = {
        id,
        connector: this.name,
        model: parsed.model || request.model || DEFAULT_MODEL,
        result: parsed.text,
        structured: parsed.structured,
        usage: {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          totalTokens: parsed.inputTokens + parsed.outputTokens,
          costUsd: parsed.costUsd,
        },
        latencyMs,
        status: 'success',
      };

      if (parsed.isError || exitCode !== 0) {
        const errorType = this.classifyError(parsed.errorMessage || stderr, exitCode);
        base.status = errorType === 'rate_limited' ? 'rate_limited' : 'error';
        base.error = {
          type: errorType,
          message: parsed.errorMessage || stderr.slice(0, 500),
        };
      }

      return base;
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      return {
        id,
        connector: this.name,
        model: request.model || DEFAULT_MODEL,
        result: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        latencyMs,
        status: message.includes('timeout') ? 'timeout' : 'error',
        error: { type: message.includes('timeout') ? 'timeout' : 'spawn_error', message },
      };
    } finally {
      this.activeJobs--;
      rm(cwdPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  private spawnWithCwd(
    binary: string,
    args: string[],
    timeout: number,
    env: Record<string, string>,
    cwd: string,
  ): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args, {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        cwd,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          reject(new Error(`Process timeout after ${timeout}ms`));
        } else {
          reject(err);
        }
      });
    });
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      name: 'gemini',
      type: 'cli',
      models: ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite'],
      supportsStreaming: false,
      supportsJsonSchema: false,
      supportsTools: true,
      maxTimeout: 600_000,
    };
  }
}

import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
  IConnector,
} from './interfaces/connector.interface';
import { getConfig } from '../config/env.schema';

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

export interface ParsedCliOutput {
  text: string;
  structured?: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  isError: boolean;
  errorType?: string;
  errorMessage?: string;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export abstract class BaseCliConnector implements IConnector {
  readonly type = 'cli' as const;
  abstract readonly name: string;

  protected activeJobs = 0;
  private _semaphore?: Semaphore;

  protected get semaphore(): Semaphore {
    if (!this._semaphore) {
      try {
        this._semaphore = new Semaphore(getConfig().CONNECTOR_MAX_CONCURRENCY);
      } catch {
        this._semaphore = new Semaphore(1);
      }
    }
    return this._semaphore;
  }

  /** @internal For testing only — override the concurrency limit */
  setSemaphore(max: number): void {
    this._semaphore = new Semaphore(max);
  }

  protected abstract getBinaryPath(): string;
  protected abstract buildArgs(request: ConnectorRequest): string[];
  protected abstract parseOutput(stdout: string, stderr: string): ParsedCliOutput;
  abstract getCapabilities(): ConnectorCapabilities;

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    await this.semaphore.acquire();
    const id = randomUUID();
    const timeout = request.timeout ?? 300_000;
    const start = Date.now();

    // CWD isolation: spawn from temp dir to prevent CLI workspace scanning
    const cwdPath = await mkdtemp(join(tmpdir(), `${this.name}_`));

    this.activeJobs++;
    try {
      const { stdout, stderr, exitCode } = await this.spawnProcess(
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
        model: parsed.model || request.model || 'unknown',
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
        model: request.model || 'unknown',
        result: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        latencyMs,
        status: message.includes('timeout') ? 'timeout' : 'error',
        error: { type: message.includes('timeout') ? 'timeout' : 'spawn_error', message },
      };
    } finally {
      this.activeJobs--;
      this.semaphore.release();
      rm(cwdPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getStatus(): Promise<ConnectorStatus> {
    return {
      name: this.name,
      healthy: true,
      activeJobs: this.activeJobs,
      queuedJobs: this.semaphore.pending,
      rateLimitStatus: 'ok',
    };
  }

  protected getEnv(_request: ConnectorRequest): Record<string, string> {
    return {};
  }

  protected spawnProcess(
    binary: string,
    args: string[],
    timeout: number,
    env: Record<string, string>,
    cwd?: string,
  ): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args, {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        ...(cwd && { cwd }),
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

  protected classifyError(message: string, exitCode: number): string {
    const lower = message.toLowerCase();
    if (lower.includes('rate limit') || lower.includes('overloaded') || lower.includes('429')) {
      return 'rate_limited';
    }
    if (lower.includes('unauthorized') || lower.includes('not logged in')) {
      return 'auth_error';
    }
    if (lower.includes('timeout') || lower.includes('timed out')) {
      return 'timeout';
    }
    if (exitCode === 127) {
      return 'binary_not_found';
    }
    return 'execution_error';
  }

  protected buildSystemPromptWithJsonMode(request: ConnectorRequest): string | undefined {
    const jsonInstruction =
      'You must respond with valid JSON only. No markdown, no code fences, no explanation — output raw JSON.';

    const needsJsonMode =
      request.responseFormat?.type === 'json_object' && !request.jsonSchema;

    if (needsJsonMode && request.systemPrompt) {
      return `${jsonInstruction}\n\n${request.systemPrompt}`;
    }
    if (needsJsonMode) {
      return jsonInstruction;
    }
    return request.systemPrompt;
  }

  static hashPrompt(prompt: string): string {
    return createHash('sha256').update(prompt).digest('hex');
  }
}

import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CircuitBreakerResetEntry,
  ConnectorCapabilities,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorStatus,
  IConnector,
  classifyErrorAction,
} from './interfaces/connector.interface';
import { getConfig } from '../config/env.schema';
import { CircuitOpenError } from '../core/resilience/circuit-breaker';
import { CircuitBreakerManager } from '../core/resilience/circuit-breaker-manager';

export class QueueTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Queue wait timeout after ${timeoutMs}ms`);
    this.name = 'QueueTimeoutError';
  }
}

export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(timeoutMs?: number): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    if (timeoutMs === undefined) {
      return new Promise<void>((resolve) => this.queue.push(resolve));
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new QueueTimeoutError(timeoutMs));
      }, timeoutMs);

      const entry = () => {
        clearTimeout(timer);
        resolve();
      };
      this.queue.push(entry);
    });
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

  get active(): number {
    return this.current;
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
  private _cbManager?: CircuitBreakerManager;

  protected get semaphore(): Semaphore {
    if (!this._semaphore) {
      try {
        const config = getConfig();
        const envKey =
          `${this.name.toUpperCase().replace(/-/g, '_')}_MAX_CONCURRENCY` as keyof typeof config;
        const limit = (config[envKey] as number | undefined) ?? config.CONNECTOR_MAX_CONCURRENCY;
        this._semaphore = new Semaphore(limit);
      } catch {
        this._semaphore = new Semaphore(4);
      }
    }
    return this._semaphore;
  }

  protected getQueueTimeout(): number {
    try {
      return getConfig().CONNECTOR_QUEUE_TIMEOUT_MS;
    } catch {
      return 60_000;
    }
  }

  protected get cbManager(): CircuitBreakerManager {
    if (!this._cbManager) {
      try {
        const config = getConfig();
        this._cbManager = new CircuitBreakerManager(
          this.name,
          config.CIRCUIT_BREAKER_THRESHOLD,
          config.CIRCUIT_BREAKER_COOLDOWN_MS,
        );
      } catch {
        this._cbManager = new CircuitBreakerManager(this.name, 5, 30_000);
      }
    }
    return this._cbManager;
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
    const id = randomUUID();

    // Circuit breaker check (per-model)
    const modelCb = this.cbManager.getCircuitBreaker(request.model ?? '');
    try {
      modelCb.check();
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        const action = classifyErrorAction('circuit_open');
        return {
          id,
          connector: this.name,
          model: request.model || 'unknown',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: 0,
          queueWaitMs: 0,
          status: 'error',
          error: {
            type: 'circuit_open',
            message: err.message,
            retryAfter: Math.max(0, err.nextRetryAt - Date.now()),
            ...action,
          },
        };
      }
      throw err;
    }

    const queueStart = Date.now();

    try {
      await this.semaphore.acquire(this.getQueueTimeout());
    } catch (err) {
      if (err instanceof QueueTimeoutError) {
        const action = classifyErrorAction('queue_timeout');
        return {
          id,
          connector: this.name,
          model: request.model || 'unknown',
          result: '',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: Date.now() - queueStart,
          queueWaitMs: Date.now() - queueStart,
          status: 'error',
          error: {
            type: 'queue_timeout',
            message: err.message,
            ...action,
          },
        };
      }
      throw err;
    }

    const queueWaitMs = Date.now() - queueStart;
    const timeout = request.timeout ?? 120_000;
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
        queueWaitMs,
        status: 'success',
      };

      if (parsed.isError || (exitCode !== 0 && !parsed.text)) {
        const errorType = parsed.errorType
          ? parsed.errorType
          : this.classifyError(parsed.errorMessage || stderr, exitCode);
        const action = classifyErrorAction(errorType);
        base.status = errorType === 'rate_limited' ? 'rate_limited' : 'error';
        base.error = {
          type: errorType,
          message: parsed.errorMessage || stderr.slice(0, 500),
          ...action,
        };
        modelCb.recordFailure(errorType);
      } else {
        modelCb.recordSuccess();
      }

      return base;
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      const errorType = message.includes('timeout') ? 'timeout' : 'spawn_error';
      const action = classifyErrorAction(errorType);
      modelCb.recordFailure(errorType);
      return {
        id,
        connector: this.name,
        model: request.model || 'unknown',
        result: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        latencyMs,
        queueWaitMs,
        status: message.includes('timeout') ? 'timeout' : 'error',
        error: { type: errorType, message, ...action },
      };
    } finally {
      this.activeJobs--;
      this.semaphore.release();
      rm(cwdPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getStatus(): Promise<ConnectorStatus> {
    const { aggregate, perModel } = this.cbManager.getStates();
    return {
      name: this.name,
      healthy: aggregate.state !== 'open',
      activeJobs: this.activeJobs,
      queuedJobs: this.semaphore.pending,
      rateLimitStatus: 'ok',
      circuitBreaker: aggregate,
      circuitBreakers: perModel,
    };
  }

  resetCircuitBreaker(model?: string): CircuitBreakerResetEntry[] {
    const results = model
      ? [this.cbManager.resetModel(model)].filter(Boolean)
      : this.cbManager.resetAll();
    return results.map((r) => ({
      connector: this.name,
      model: r!.model,
      previousState: r!.previousState,
    }));
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

  protected buildPromptWithJsonMode(request: ConnectorRequest): string {
    const jsonInstruction =
      'You must respond with valid JSON only. No markdown, no code fences, no explanation — output raw JSON.';

    if (request.responseFormat?.type === 'json_object') {
      return `${jsonInstruction}\n\n${request.prompt}`;
    }
    return request.prompt;
  }

  protected buildSystemPromptWithJsonMode(request: ConnectorRequest): string | undefined {
    const jsonInstruction =
      'You must respond with valid JSON only. No markdown, no code fences, no explanation — output raw JSON.';

    const needsJsonMode = request.responseFormat?.type === 'json_object' && !request.jsonSchema;

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

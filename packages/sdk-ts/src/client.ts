import {
  ConnectorError,
  GuardExhaustedError,
  NodeVersionError,
  TimeoutError,
  redactCause,
} from './errors.js';
import type {
  ClientOptions,
  ExecuteErrorEnvelope,
  ExecuteRequest,
  ExecuteResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'https://connector.arcanada.ai';
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_NODE_MAJOR = 20;

function assertNodeVersion(): void {
  // Browsers / edge runtimes do not expose `process` — DI is the supported path there.
  const proc =
    typeof globalThis !== 'undefined'
      ? (globalThis as { process?: { versions?: { node?: string } } }).process
      : undefined;
  const nodeVer = proc?.versions?.node;
  if (!nodeVer) return;
  const major = Number(nodeVer.split('.')[0]);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    throw new NodeVersionError(nodeVer, `>=${MIN_NODE_MAJOR}`);
  }
}

export class Client {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(opts: ClientOptions) {
    if (!opts || typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
      throw new Error('Client requires { apiKey: string }');
    }
    const injectedFetch = opts.fetch;
    if (!injectedFetch) {
      assertNodeVersion();
      if (typeof globalThis.fetch !== 'function') {
        throw new NodeVersionError(
          typeof process !== 'undefined' ? process.versions?.node ?? 'unknown' : 'unknown',
          `>=${MIN_NODE_MAJOR}`,
        );
      }
    }
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = injectedFetch ?? globalThis.fetch.bind(globalThis);
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    const url = `${this.#baseUrl}/execute`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        throw new TimeoutError(this.#timeoutMs);
      }
      const wrapped = err instanceof Error ? err : new Error(String(err));
      throw new ConnectorError(`Network error: ${wrapped.message}`, 0, {
        type: 'network_error',
        message: wrapped.message,
        retryable: true,
        recommendation: 'retry',
      });
    } finally {
      clearTimeout(timer);
    }

    let body: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    if (res.status === 201 || res.status === 200) {
      return body as ExecuteResponse;
    }

    const envelope = extractError(body, res);
    const message = envelope?.message ?? `HTTP ${res.status}`;
    if (envelope?.type === 'guard_exhausted') {
      const e = new GuardExhaustedError(message, res.status, envelope);
      (e as Error & { cause?: unknown }).cause = redactCause(body);
      throw e;
    }
    const e = new ConnectorError(message, res.status, envelope);
    (e as Error & { cause?: unknown }).cause = redactCause(body);
    throw e;
  }
}

function extractError(body: unknown, res: Response): ExecuteErrorEnvelope | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const candidate = (obj.error ?? obj) as Partial<ExecuteErrorEnvelope> & {
    type?: unknown;
    message?: unknown;
  };
  if (typeof candidate?.type !== 'string') return undefined;
  const retryAfterHeader = res.headers.get('retry-after');
  const retryAfter =
    typeof candidate.retryAfter === 'number'
      ? candidate.retryAfter
      : retryAfterHeader
        ? Number(retryAfterHeader)
        : undefined;
  return {
    type: candidate.type,
    message: typeof candidate.message === 'string' ? candidate.message : `HTTP ${res.status}`,
    retryAfter,
    retryable: candidate.retryable ?? false,
    recommendation: (candidate.recommendation as ExecuteErrorEnvelope['recommendation']) ?? 'abort',
  };
}

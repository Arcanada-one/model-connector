import type { ExecuteErrorEnvelope } from './types.js';

export class ConnectorError extends Error {
  public readonly status: number;
  public readonly envelope?: ExecuteErrorEnvelope;
  public readonly retryAfter?: number;

  constructor(message: string, status: number, envelope?: ExecuteErrorEnvelope) {
    super(message);
    this.name = 'ConnectorError';
    this.status = status;
    this.envelope = envelope;
    this.retryAfter = envelope?.retryAfter;
  }
}

export class GuardExhaustedError extends ConnectorError {
  constructor(message: string, status: number, envelope?: ExecuteErrorEnvelope) {
    super(message, status, envelope);
    this.name = 'GuardExhaustedError';
  }
}

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export class NodeVersionError extends Error {
  constructor(actual: string, required: string) {
    super(
      `Arcanada Model Connector SDK requires Node ${required} or newer (got ${actual}). ` +
        `Upgrade Node, or supply a fetch polyfill via new Client({ fetch }).`,
    );
    this.name = 'NodeVersionError';
  }
}

const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+/=]+/g;

function redactString(input: string): string {
  return input.replace(BEARER_RE, 'Bearer [REDACTED]');
}

export function redactCause(cause: unknown, depth = 0): unknown {
  if (depth > 10 || cause === null || cause === undefined) return cause;
  if (typeof cause === 'string') return redactString(cause);
  if (cause instanceof Error) {
    const copy = new Error(redactString(cause.message));
    copy.name = cause.name;
    if ('cause' in cause) {
      (copy as Error & { cause?: unknown }).cause = redactCause(
        (cause as Error & { cause?: unknown }).cause,
        depth + 1,
      );
    }
    return copy;
  }
  if (typeof cause === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cause as Record<string, unknown>)) {
      if (/^authorization$/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactCause(v, depth + 1);
      }
    }
    return out;
  }
  return cause;
}

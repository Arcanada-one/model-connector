// ARCA-0011 — multi-modal prompt block. Aligned with Anthropic / OpenRouter
// canonical content-block shape. CLI connectors accept the union at DTO level
// but reject `ContentBlock[]` at runtime with `unsupported_modality` until
// per-CLI binary support lands (CONN-0209).
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
    };

export interface ConnectorRequest {
  prompt: string | ContentBlock[];
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: 'low' | 'medium' | 'high';
  jsonSchema?: Record<string, unknown>;
  responseFormat?: { type: 'json_object' | 'text' };
  timeout?: number;
  extra?: Record<string, unknown>;
}

export type ErrorAction = 'retry' | 'abort' | 'wait' | 'reauth';

export interface ConnectorError {
  type: string;
  message: string;
  retryAfter?: number;
  retryable: boolean;
  recommendation: ErrorAction;
}

export interface ConnectorResponse {
  id: string;
  connector: string;
  model: string;
  result: string;
  structured?: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  latencyMs: number;
  queueWaitMs?: number;
  attempt?: number;
  maxAttempts?: number;
  status: 'success' | 'error' | 'timeout' | 'rate_limited';
  error?: ConnectorError;
  // CONN-0089 — populated only when the request supplied `output_format`.
  // Null/undefined preserves byte-identity for legacy callers (V-AC-3).
  repair_report?: import('../output-guard/types').OutputGuardReport;
}

const ERROR_ACTION_MAP: Record<string, { retryable: boolean; recommendation: ErrorAction }> = {
  rate_limited: { retryable: true, recommendation: 'wait' },
  timeout: { retryable: true, recommendation: 'retry' },
  server_error: { retryable: true, recommendation: 'retry' },
  json_parse_error: { retryable: true, recommendation: 'retry' },
  execution_error: { retryable: true, recommendation: 'retry' },
  queue_timeout: { retryable: true, recommendation: 'wait' },
  network_error: { retryable: true, recommendation: 'retry' },
  spawn_error: { retryable: true, recommendation: 'retry' },
  circuit_open: { retryable: false, recommendation: 'wait' },
  auth_error: { retryable: false, recommendation: 'reauth' },
  binary_not_found: { retryable: false, recommendation: 'abort' },
  validation_error: { retryable: false, recommendation: 'abort' },
  billing_error: { retryable: false, recommendation: 'abort' },
  credit_depleted: { retryable: false, recommendation: 'abort' },
  budget_exceeded: { retryable: false, recommendation: 'abort' },
  max_turns_exceeded: { retryable: false, recommendation: 'abort' },
  max_output_tokens: { retryable: false, recommendation: 'abort' },
  structured_output_error: { retryable: true, recommendation: 'retry' },
  parse_error: { retryable: true, recommendation: 'retry' },
  http_error: { retryable: true, recommendation: 'retry' },
  model_not_found: { retryable: false, recommendation: 'abort' },
  api_error: { retryable: true, recommendation: 'retry' },
  unsupported_modality: { retryable: false, recommendation: 'abort' },
};

export function classifyErrorAction(errorType: string): {
  retryable: boolean;
  recommendation: ErrorAction;
} {
  return ERROR_ACTION_MAP[errorType] ?? { retryable: false, recommendation: 'abort' };
}

export interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  nextRetryAt?: number;
  lastErrorType: string | null;
}

export interface ConnectorStatus {
  name: string;
  healthy: boolean;
  version?: string;
  activeJobs: number;
  queuedJobs: number;
  rateLimitStatus: 'ok' | 'approaching' | 'limited';
  rateLimitResetsAt?: string;
  circuitBreaker?: CircuitBreakerState;
  circuitBreakers?: Record<string, CircuitBreakerState>;
}

export interface ConnectorCapabilities {
  name: string;
  type: 'cli' | 'api';
  models: string[];
  supportsStreaming: boolean;
  supportsJsonSchema: boolean;
  supportsTools: boolean;
  maxTimeout: number;
  // CONN-0223 — optional field for connectors that expose a free tier.
  freeModels?: string[];
}

export interface CircuitBreakerResetEntry {
  connector: string;
  model: string;
  previousState: 'closed' | 'open' | 'half_open';
}

export interface IConnector {
  readonly name: string;
  readonly type: 'cli' | 'api';

  execute(request: ConnectorRequest): Promise<ConnectorResponse>;
  getStatus(): Promise<ConnectorStatus>;
  getCapabilities(): ConnectorCapabilities;
  resetCircuitBreaker(model?: string): CircuitBreakerResetEntry[];
}

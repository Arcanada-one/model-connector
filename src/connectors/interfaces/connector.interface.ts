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

// CONN-0238 — per-model metadata carried alongside the flat `models` id list.
// Lets one connector span multiple modalities (groq: chat + STT + TTS + moderation;
// grok: chat + image + video) and surface real pricing/context from the live
// `/models` API. Every field is optional: a connector that only knows ids emits
// `{ id }`; the catalog falls back to the connector-wide modality and null
// pricing/context. The catalog derives `models` from these metas, so the two never
// drift (consilium HIGH — single source of truth).
export interface ProviderModelMeta {
  id: string;
  /** Per-model modality; the catalog falls back to the connector default when omitted. */
  modality?: import('../dto/catalog.dto').ModelModality;
  /** Per-model free-tier flag (e.g. openrouter ':free'); overrides the connector free set. */
  free?: boolean;
  /** Normalised pricing from the provider's live /models API. Null = no machine price. */
  pricing?: import('../dto/catalog.dto').ModelPricing | null;
  /** Provider-published context window (tokens). */
  contextWindow?: number | null;
  /** Provider-published max output/completion tokens. */
  maxOutputTokens?: number | null;
}

export interface ConnectorCapabilities {
  name: string;
  // Transport — HOW we reach the provider. NOT the model modality (CONN-0232).
  type: 'cli' | 'api';
  models: string[];
  supportsStreaming: boolean;
  supportsJsonSchema: boolean;
  supportsTools: boolean;
  maxTimeout: number;
  // CONN-0223 — optional field for connectors that expose a free tier.
  freeModels?: string[];
  // CONN-0232 — model modality (a.k.a `type` in the catalog DTO). Distinct from
  // transport `type` above. Defaults to 'chat' in the catalog when omitted; the
  // embedding connector sets 'embedding'. A string here (not the DTO enum) keeps
  // this interface free of a dto import; the catalog validates against the enum.
  modality?: import('../dto/catalog.dto').ModelModality;
  // CONN-0238 — per-model metadata (modality / free / pricing / context). When
  // present the catalog uses it per-model; when absent it falls back to the flat
  // `models` list + connector-wide `modality`. Derived from the same source as
  // `models` (see ProviderModelMeta) so they cannot drift.
  modelMeta?: ProviderModelMeta[];
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

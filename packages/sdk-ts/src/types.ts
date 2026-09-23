// Mirrors server contract:
//   src/connectors/dto/execute.dto.ts:9-25 (executeRequestBaseShape)
//   src/connectors/interfaces/connector.interface.ts:25-46 (ConnectorResponse)
//   src/connectors/output-guard/types.ts:16-22 (OutputGuardReport)
// Schema fidelity: 1:1 wire mirror. Drift requires architecture decision record.

export type OutputFormat = 'json' | 'yaml' | 'toml' | 'python' | 'auto';

export interface ResponseFormat {
  type: 'json_object' | 'text';
}

export interface FirstDispatchMeasurementV0 {
  version: 'first-dispatch-measurement/v0';
  corpusId: string;
  caseId: string;
  roleId: string;
  taskClassId: string;
  commandId: string;
  replayIndex: number;
  variant: 'baseline' | 'compiled';
  adapterBoundary: 'arcana-agent-system/driver/first-dispatch-v0';
}

export interface ExecuteRequest {
  connector: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: 'low' | 'medium' | 'high';
  jsonSchema?: Record<string, unknown>;
  responseFormat?: ResponseFormat;
  timeout?: number;
  extra?: Record<string, unknown>;
  // output-guard opt-in
  output_format?: OutputFormat;
  schema?: Record<string, unknown>;
  firstDispatchMeasurement?: FirstDispatchMeasurementV0;
}

export type OutputGuardPass = 'native' | 'guarded' | 'failed';

export interface RepairReport {
  strategies_applied: string[];
  retries: number;
  final_valid: boolean;
  pass: OutputGuardPass;
  error?: string;
}

export type ExecuteStatus = 'success' | 'error' | 'timeout' | 'rate_limited';

export type ErrorAction = 'retry' | 'abort' | 'wait' | 'reauth';

export type ErrorType =
  | 'rate_limited'
  | 'timeout'
  | 'server_error'
  | 'json_parse_error'
  | 'execution_error'
  | 'queue_timeout'
  | 'network_error'
  | 'spawn_error'
  | 'circuit_open'
  | 'auth_error'
  | 'binary_not_found'
  | 'validation_error'
  | 'billing_error'
  | 'credit_depleted'
  | 'budget_exceeded'
  | 'max_turns_exceeded'
  | 'max_output_tokens'
  | 'structured_output_error'
  | 'parse_error'
  | 'http_error'
  | 'model_not_found'
  | 'api_error'
  | 'guard_exhausted';

export interface ExecuteErrorEnvelope {
  type: ErrorType | string;
  message: string;
  /**
   * How long to wait before retrying, in MILLISECONDS. This is the unit the
   * server has always sent (an open breaker reports `nextRetryAt - now`), and
   * the unit this SDK normalises the HTTP `Retry-After` header into. Read
   * {@link retryAfterSeconds} if seconds are what you want — do not divide or
   * multiply this field yourself.
   */
  retryAfter?: number;
  /** The same delay in SECONDS, rounded up. Present whenever `retryAfter` is. */
  retryAfterSeconds?: number;
  retryable: boolean;
  recommendation: ErrorAction;
}

export interface ExecuteUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface FirstDispatchObservationV0 {
  version: 'first-dispatch-observation/v0';
  observationId: string;
  measurement: FirstDispatchMeasurementV0;
  connector: string;
  model: string;
  connectorResponseId: string;
  requestPayloadDigestSha256: string;
  requestPayloadBytes: number;
  observationBoundary: 'model-connector/service/pre-adapter-v0';
  usage: {
    inputTokens: number;
    cachedInputTokens: null;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    source: 'CONNECTOR_RESPONSE_UNVERIFIED';
  };
  latencyMs: number;
  outcome: ExecuteStatus;
  persistence: 'MODEL_CONNECTOR_POSTGRESQL';
  evidenceStatus: 'PERSISTED_PRE_ADAPTER_OBSERVATION';
  authorization: 'NOT_AUTHORIZED';
  receiptDigestSha256: string;
}

/**
 * A2-209 — the provider served the request under a different model id than the
 * one requested, and reported so itself. See `ExecuteResponse.modelSubstituted`.
 */
export interface ModelSubstitution {
  /** The model id the caller asked for. */
  requested: string;
  /** The model id the provider actually served it with. */
  served: string;
}

export interface ExecuteResponse {
  id: string;
  connector: string;
  /** The model that SERVED the request — see {@link ExecuteResponse.modelSubstituted}. */
  model: string;
  /**
   * A2-209 — present only when the provider served a different model than the
   * one requested. Providers keep retired ids alive as aliases (DeepSeek serves
   * `deepseek-chat` / `deepseek-reasoner` / `deepseek-v4-flash` as
   * `deepseek-flash`), so such a request succeeds and nothing else reports that
   * the model changed under the caller. Absent when no model was requested,
   * when the served id matches, or when the provider reported none.
   */
  modelSubstituted?: ModelSubstitution;
  result: string;
  structured?: unknown;
  usage: ExecuteUsage;
  latencyMs: number;
  queueWaitMs?: number;
  attempt?: number;
  maxAttempts?: number;
  status: ExecuteStatus;
  error?: ExecuteErrorEnvelope;
  repair_report?: RepairReport;
  firstDispatchObservation?: FirstDispatchObservationV0;
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

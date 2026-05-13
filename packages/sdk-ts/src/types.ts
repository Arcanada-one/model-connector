// Mirrors server contract:
//   src/connectors/dto/execute.dto.ts:9-25 (executeRequestBaseShape)
//   src/connectors/interfaces/connector.interface.ts:25-46 (ConnectorResponse)
//   src/connectors/output-guard/types.ts:16-22 (OutputGuardReport)
// Schema fidelity: 1:1 wire mirror. Drift requires architecture decision record.

export type OutputFormat = 'json' | 'yaml' | 'toml' | 'python' | 'auto';

export interface ResponseFormat {
  type: 'json_object' | 'text';
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
  retryAfter?: number;
  retryable: boolean;
  recommendation: ErrorAction;
}

export interface ExecuteUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface ExecuteResponse {
  id: string;
  connector: string;
  model: string;
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
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

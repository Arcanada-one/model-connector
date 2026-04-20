export interface ConnectorRequest {
  prompt: string;
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
  status: 'success' | 'error' | 'timeout' | 'rate_limited';
  error?: {
    type: string;
    message: string;
    retryAfter?: number;
  };
}

export interface ConnectorStatus {
  name: string;
  healthy: boolean;
  version?: string;
  activeJobs: number;
  queuedJobs: number;
  rateLimitStatus: 'ok' | 'approaching' | 'limited';
  rateLimitResetsAt?: string;
}

export interface ConnectorCapabilities {
  name: string;
  type: 'cli' | 'api';
  models: string[];
  supportsStreaming: boolean;
  supportsJsonSchema: boolean;
  supportsTools: boolean;
  maxTimeout: number;
}

export interface IConnector {
  readonly name: string;
  readonly type: 'cli' | 'api';

  execute(request: ConnectorRequest): Promise<ConnectorResponse>;
  getStatus(): Promise<ConnectorStatus>;
  getCapabilities(): ConnectorCapabilities;
}

export const BEDROCK_GUARDRAIL_OPERATIONS = [
  'CreateGuardrail',
  'CreateGuardrailVersion',
  'GetGuardrail',
  'ListGuardrails',
  'UpdateGuardrail',
  'DeleteGuardrail',
  'ApplyGuardrail',
] as const;

export type BedrockGuardrailOperation = (typeof BEDROCK_GUARDRAIL_OPERATIONS)[number];

export interface BedrockGuardrailsUnsignedRequest {
  operation: BedrockGuardrailOperation;
  region: string;
  service: 'bedrock';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export type BedrockGuardrailsSigner = (
  request: BedrockGuardrailsUnsignedRequest,
) => Promise<Record<string, string>>;

export interface BedrockGuardrailsTransportRequest {
  method: BedrockGuardrailsUnsignedRequest['method'];
  headers: Record<string, string>;
  body?: string;
  redirect: 'manual';
  timeoutMs: number;
}

export interface BedrockGuardrailsTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type BedrockGuardrailsTransport = (
  url: string,
  request: BedrockGuardrailsTransportRequest,
) => Promise<BedrockGuardrailsTransportResponse>;

export interface BedrockGuardrailsConfig {
  region: string;
  signer: BedrockGuardrailsSigner;
  transport: BedrockGuardrailsTransport;
  timeoutMs?: number;
}

export type BedrockGuardrailsErrorCode =
  | 'invalid_config'
  | 'invalid_request'
  | 'signing_error'
  | 'transport_error'
  | 'provider_error'
  | 'unexpected_status'
  | 'response_too_large'
  | 'invalid_response';

interface BedrockGuardrailsErrorOptions {
  status?: number;
  providerCode?: string;
  requestId?: string;
  retryable?: boolean;
}

export class BedrockGuardrailsError extends Error {
  readonly name = 'BedrockGuardrailsError';
  readonly code: BedrockGuardrailsErrorCode;
  readonly status?: number;
  readonly providerCode?: string;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(
    code: BedrockGuardrailsErrorCode,
    message: string,
    options: BedrockGuardrailsErrorOptions = {},
  ) {
    super(message);
    this.code = code;
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
  }
}

export type GuardrailStatus =
  | 'CREATING'
  | 'UPDATING'
  | 'VERSIONING'
  | 'READY'
  | 'FAILED'
  | 'DELETING';

export interface CreateGuardrailInput {
  name: string;
  blockedInputMessaging: string;
  blockedOutputsMessaging: string;
  description?: string;
  clientRequestToken?: string;
  kmsKeyId?: string;
  tags?: Array<{ key: string; value: string }>;
  automatedReasoningPolicyConfig?: Record<string, unknown>;
  contentPolicyConfig?: Record<string, unknown>;
  contextualGroundingPolicyConfig?: Record<string, unknown>;
  crossRegionConfig?: Record<string, unknown>;
  sensitiveInformationPolicyConfig?: Record<string, unknown>;
  topicPolicyConfig?: Record<string, unknown>;
  wordPolicyConfig?: Record<string, unknown>;
}

export interface UpdateGuardrailInput
  extends Omit<CreateGuardrailInput, 'clientRequestToken' | 'tags'> {
  guardrailIdentifier: string;
}

export interface ApplyGuardrailInput {
  guardrailIdentifier: string;
  guardrailVersion: string;
  source: 'INPUT' | 'OUTPUT';
  outputScope?: 'INTERVENTIONS' | 'FULL';
  content: Array<
    | {
        text: {
          text: string;
          qualifiers?: Array<'grounding_source' | 'query' | 'guard_content'>;
        };
      }
    | {
        image: {
          format: 'png' | 'jpeg';
          source: { bytes: string };
        };
      }
  >;
}

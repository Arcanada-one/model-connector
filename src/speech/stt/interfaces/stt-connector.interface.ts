// CONN-0102 — ISttConnector lives parallel to IConnector intentionally:
// STT request payload is binary audio + multipart fields, not chat-shaped
// {prompt, model, jsonSchema}. Forcing it through ConnectorRequest would
// shoehorn audio into `prompt: string`. We keep IConnector chat-only and
// give STT its own narrow contract.

import type { CircuitBreakerState } from '../../../connectors/interfaces/connector.interface';

export interface SttConnectorRequest {
  /** Audio file payload — already buffered. Size enforced by router upstream. */
  file: Buffer;
  /** Original filename (mostly informational; some providers infer codec). */
  filename?: string;
  /** Validated MIME type (already through STT_ALLOWED_MIME_TYPES whitelist). */
  mimeType: string;
  /** Raw bytes for audit/metrics — must match `file.length`. */
  audioBytes: number;
  /** Optional BCP-47 hint; if omitted, provider auto-detects. */
  language?: string;
  /** Optional model override (e.g., `whisper-large-v3-turbo`). */
  model?: string;
  /** Whisper bias prompt (≤1024 chars; already enforced by Zod). */
  prompt?: string;
  /** 0..1 sampling temperature (already coerced by Zod). */
  temperature?: number;
  /** Client- or controller-issued correlation ID; surfaced in logs. */
  requestId: string;
  /** Optional per-call timeout override (ms). */
  timeoutMs?: number;
}

export interface SttConnectorResult {
  transcription: string;
  /** Provider-detected (or echoed) language. May be natural-language label or BCP-47. */
  detectedLanguage?: string;
  audioDurationSeconds?: number;
  model: string;
  costUsd: number;
  latencyMs: number;
  /** Provider-side request id (e.g., Groq's `x_groq.id`) — logged, not surfaced to client. */
  providerRequestId?: string;
}

export interface SttConnectorStatus {
  name: string;
  healthy: boolean;
  activeJobs: number;
  queuedJobs: number;
  circuitBreaker?: CircuitBreakerState;
}

export interface ISttConnector {
  readonly name: string; // e.g., 'groq-stt'
  readonly provider: string; // e.g., 'groq' — used in audit + envelope
  transcribe(request: SttConnectorRequest): Promise<SttConnectorResult>;
  getStatus(): Promise<SttConnectorStatus>;
}

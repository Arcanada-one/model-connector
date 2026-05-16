// CONN-0102 — typed errors for the STT routing pipeline.
// Kept narrow: каждый класс несёт минимум полей, нужных для envelope-проекции
// в SpeechController. Конкретные http-mappings — в speech-response.dto.ts.

export type SttProviderErrorType =
  | 'auth_failed'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'timeout'
  | 'parse_error'
  | 'http_error';

export class SttProviderError extends Error {
  readonly name = 'SttProviderError';
  constructor(
    readonly provider: string,
    readonly type: SttProviderErrorType,
    message: string,
    readonly upstreamCode?: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

export class SttAllProvidersExhausted extends Error {
  readonly name = 'SttAllProvidersExhausted';
  constructor(
    readonly providersTried: string[],
    readonly lastError?: SttProviderError,
  ) {
    super(`STT cascade exhausted; tried providers: ${providersTried.join(', ')}`);
  }
}

export class SttAudioTooLargeError extends Error {
  readonly name = 'SttAudioTooLargeError';
  constructor(
    readonly receivedBytes: number,
    readonly maxBytes: number,
  ) {
    super(`Audio payload ${receivedBytes} bytes exceeds limit ${maxBytes} bytes`);
  }
}

export class SttUnsupportedMimeError extends Error {
  readonly name = 'SttUnsupportedMimeError';
  constructor(
    readonly mimeType: string,
    readonly allowed: readonly string[],
  ) {
    super(`Unsupported audio MIME "${mimeType}"; allowed: ${allowed.join(', ')}`);
  }
}

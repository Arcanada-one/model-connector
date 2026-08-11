import type { AwsHttpResponse, AwsSpeechService } from './transports';

export class AwsSpeechValidationError extends Error {
  readonly code = 'aws_speech_validation_error';

  constructor(message: string) {
    super(message);
    this.name = 'AwsSpeechValidationError';
  }
}

export class AwsSpeechServiceError extends Error {
  readonly name = 'AwsSpeechServiceError';

  constructor(
    readonly service: AwsSpeechService,
    readonly operation: string,
    readonly providerCode: string,
    message: string,
    readonly statusCode: number,
    readonly requestId: string | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const normalizeCode = (value: string | undefined): string =>
  (value ?? 'UnknownAwsError').split(':').pop() ?? 'UnknownAwsError';

const retryableCode = (code: string, statusCode: number): boolean =>
  statusCode === 429 ||
  statusCode >= 500 ||
  /Throttl|LimitExceeded|ServiceUnavailable|Internal(Failure|Error)/i.test(code);

export function parseAwsHttpError(
  service: AwsSpeechService,
  operation: string,
  response: AwsHttpResponse,
): AwsSpeechServiceError {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const headerCode = response.headers['x-amzn-errortype'];
  const providerCode = normalizeCode(
    headerCode ??
      (typeof body.__type === 'string' ? body.__type : undefined) ??
      (typeof body.code === 'string' ? body.code : undefined),
  );
  const message =
    (typeof body.message === 'string' && body.message) ||
    (typeof body.Message === 'string' && body.Message) ||
    providerCode;
  return new AwsSpeechServiceError(
    service,
    operation,
    providerCode,
    message,
    response.statusCode,
    response.headers['x-amzn-requestid'],
    retryableCode(providerCode, response.statusCode),
  );
}

export function parseAwsEventStreamError(event: {
  type?: 'exception';
  code: string;
  message: string;
  requestId?: string;
}): AwsSpeechServiceError {
  const statusCode = /LimitExceeded/i.test(event.code) ? 429 : 400;
  return new AwsSpeechServiceError(
    'transcribe',
    'StartStreamTranscription',
    event.code,
    event.message,
    statusCode,
    event.requestId,
    retryableCode(event.code, statusCode),
  );
}

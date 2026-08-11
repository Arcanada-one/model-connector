interface AzureSpeechErrorOptions {
  statusCode: number;
  code: string;
  message: string;
  payload?: unknown;
  details?: unknown;
  innerError?: unknown;
}

export class AzureSpeechError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly payload: unknown;
  readonly details: unknown;
  readonly innerError: unknown;

  constructor(options: AzureSpeechErrorOptions) {
    super(options.message);
    this.name = 'AzureSpeechError';
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.payload = options.payload;
    this.details = options.details;
    this.innerError = options.innerError;
  }
}

export function localAzureSpeechError(
  code: string,
  message: string,
  payload?: unknown,
): AzureSpeechError {
  return new AzureSpeechError({
    statusCode: 0,
    code,
    message,
    payload,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

export function errorFromProviderPayload(statusCode: number, payload: unknown): AzureSpeechError {
  if (typeof payload === 'string') {
    return new AzureSpeechError({
      statusCode,
      code: 'AzureSpeechHttpError',
      message: payload || `Azure Speech returned HTTP ${statusCode}`,
      payload,
    });
  }

  if (!isRecord(payload)) {
    return new AzureSpeechError({
      statusCode,
      code: 'AzureSpeechHttpError',
      message: `Azure Speech returned HTTP ${statusCode}`,
      payload,
    });
  }

  const directError = nestedRecord(payload, 'error');
  const properties = nestedRecord(payload, 'properties');
  const propertyError = properties ? nestedRecord(properties, 'error') : undefined;
  const error = directError ?? propertyError ?? payload;

  return new AzureSpeechError({
    statusCode,
    code: typeof error.code === 'string' ? error.code : 'AzureSpeechHttpError',
    message:
      typeof error.message === 'string'
        ? error.message
        : `Azure Speech returned HTTP ${statusCode}`,
    payload,
    details: error.details,
    innerError: error.innerError,
  });
}

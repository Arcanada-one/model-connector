import { googleApiErrorSchema } from './google-cloud-speech.schemas';
import type { GoogleSpeechHttpResponse } from './google-cloud-speech.transport';
import type { GoogleRpcStatus, JsonObject } from './google-cloud-speech.types';

export class GoogleCloudSpeechApiError extends Error {
  readonly httpStatus: number;
  readonly status?: string;
  readonly details?: JsonObject[];

  constructor(input: {
    httpStatus: number;
    message: string;
    status?: string;
    details?: JsonObject[];
  }) {
    super(input.message);
    this.name = 'GoogleCloudSpeechApiError';
    this.httpStatus = input.httpStatus;
    this.status = input.status;
    this.details = input.details;
  }
}

export class GoogleCloudSpeechOperationError extends Error {
  readonly status: GoogleRpcStatus;

  constructor(status: GoogleRpcStatus) {
    super(status.message);
    this.name = 'GoogleCloudSpeechOperationError';
    this.status = status;
  }
}

export function assertSuccessfulResponse(response: GoogleSpeechHttpResponse): unknown {
  if (response.status >= 200 && response.status < 300) {
    return response.body;
  }
  const parsed = googleApiErrorSchema.safeParse(response.body);
  if (!parsed.success) {
    throw new GoogleCloudSpeechApiError({
      httpStatus: response.status,
      message: `Google Cloud Speech request failed with HTTP ${response.status}`,
    });
  }
  throw new GoogleCloudSpeechApiError({
    httpStatus: response.status,
    message: parsed.data.error.message,
    status: parsed.data.error.status,
    details: parsed.data.error.details,
  });
}

export class ElevenLabsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
    readonly requestId?: string,
    readonly traceId?: string,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = 'ElevenLabsError';
  }
}

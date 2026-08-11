export class RecraftError extends Error {
  readonly status: number;
  readonly rawBody: string;
  readonly parsedBody: unknown;

  constructor(status: number, rawBody: string, parsedBody: unknown, message?: string) {
    super(message ?? `Recraft request failed with HTTP ${status}`);
    this.name = 'RecraftError';
    this.status = status;
    this.rawBody = rawBody;
    this.parsedBody = parsedBody;
  }
}

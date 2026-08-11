import type { LeonardoProviderError } from './leonardo-ai.types';

export class LeonardoApiError extends Error {
  readonly name = 'LeonardoApiError';
  readonly code?: string;
  readonly path?: string;
  readonly providerError?: string;

  constructor(
    readonly status: number,
    provider: Partial<LeonardoProviderError>,
  ) {
    const safeCode = typeof provider.code === 'string' ? provider.code : 'unknown';
    super(`Leonardo API request failed with HTTP ${status}: ${safeCode}`);
    this.code = provider.code;
    this.path = provider.path;
    this.providerError = provider.error;
  }
}

export class LeonardoProtocolError extends Error {
  readonly name = 'LeonardoProtocolError';

  constructor(detail: string) {
    super(`Leonardo API protocol error: ${detail}`);
  }
}

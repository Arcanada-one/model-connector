import { HttpException, HttpStatus } from '@nestjs/common';
import type { ProviderId } from '../types';

/**
 * Thrown when a connector detects PLACEHOLDER_* credentials at generation time.
 * HTTP 503 Service Unavailable — the connector is implemented but not yet provisioned.
 * See: memory feedback_vault_placeholder_password, CONN-0052.
 */
export class ProviderNotProvisionedError extends HttpException {
  constructor(provider: ProviderId | string, vaultPath: string) {
    super(
      {
        code: 'PROVIDER_NOT_PROVISIONED',
        provider,
        vaultPath,
        message: `Provider ${provider} is not provisioned. Missing credentials at Vault path ${vaultPath}.`,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    this.name = 'ProviderNotProvisionedError';
  }
}

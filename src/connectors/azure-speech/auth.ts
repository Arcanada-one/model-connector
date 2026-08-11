import { localAzureSpeechError } from './errors';
import type { AzureSpeechAuthentication, AzureSpeechDeployment } from './types';

type AzureSpeechRestOperation = 'fast-or-batch' | 'tts-or-voices';

function requireNonempty(value: string, field: string): string {
  if (value.trim() === '') {
    throw localAzureSpeechError('InvalidAuthentication', `${field} must be nonempty.`);
  }
  return value;
}

export function assertAzureSpeechAuthenticationSupported(
  authentication: AzureSpeechAuthentication,
  deployment: AzureSpeechDeployment,
  operation: AzureSpeechRestOperation | 'streaming',
): void {
  if (authentication.kind === 'resource-key') {
    requireNonempty(authentication.key, 'Resource key');
    return;
  }

  requireNonempty(authentication.resourceId, 'Microsoft Entra resource ID');
  requireNonempty(authentication.accessToken, 'Microsoft Entra access token');

  if (operation === 'fast-or-batch') {
    throw localAzureSpeechError(
      'UnsupportedAuthentication',
      'Speech to Text REST API 2025-10-15 fast and batch operations document resource-key authentication only.',
    );
  }

  if (deployment.kind === 'resource-endpoint' && deployment.networkAccess === 'restricted') {
    throw localAzureSpeechError(
      'UnsupportedAuthentication',
      'Restricted resource endpoints require resource-key authentication.',
    );
  }
}

export function azureSpeechRestAuthenticationHeaders(
  authentication: AzureSpeechAuthentication,
  deployment: AzureSpeechDeployment,
  operation: AzureSpeechRestOperation,
): Record<string, string> {
  assertAzureSpeechAuthenticationSupported(authentication, deployment, operation);

  if (authentication.kind === 'resource-key') {
    return {
      'Ocp-Apim-Subscription-Key': authentication.key,
    };
  }

  return {
    Authorization: `Bearer aad#${authentication.resourceId}#${authentication.accessToken}`,
  };
}

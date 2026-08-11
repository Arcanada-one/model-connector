import { localAzureSpeechError } from './errors';
import type { AzureSpeechDeployment } from './types';

export interface AzureSpeechAuthorities {
  management: string;
  streaming: string;
  textToSpeech: string;
  resourceEndpoint: boolean;
}

function normalizeRegion(region: string): string {
  const normalized = region.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw localAzureSpeechError(
      'InvalidDeployment',
      'A public Azure region must be a nonempty region identifier.',
    );
  }
  return normalized;
}

function normalizeResourceAuthority(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw localAzureSpeechError(
      'InvalidDeployment',
      'A resource endpoint must be an exact HTTPS authority.',
    );
  }

  if (
    url.protocol !== 'https:' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw localAzureSpeechError(
      'InvalidDeployment',
      'A resource endpoint must be an exact HTTPS authority without path, query, fragment, or credentials.',
    );
  }

  return url.origin;
}

export function azureSpeechAuthorities(deployment: AzureSpeechDeployment): AzureSpeechAuthorities {
  if (deployment.kind === 'public-region') {
    const region = normalizeRegion(deployment.region);
    return {
      management: `https://${region}.api.cognitive.microsoft.com`,
      streaming: `wss://${region}.stt.speech.microsoft.com`,
      textToSpeech: `https://${region}.tts.speech.microsoft.com`,
      resourceEndpoint: false,
    };
  }

  const authority = normalizeResourceAuthority(deployment.endpoint);
  return {
    management: authority,
    streaming: authority.replace(/^https:/, 'wss:'),
    textToSpeech: authority,
    resourceEndpoint: true,
  };
}

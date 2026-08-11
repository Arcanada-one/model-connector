import { assertLocation } from './google-cloud-speech.validation';

const V1_STT_LOCATIONS = new Set(['global', 'us', 'eu']);
const TTS_LOCATIONS = new Set(['global', 'us', 'eu', 'us-central1']);

export function speechV1Endpoint(location: string): string {
  if (!V1_STT_LOCATIONS.has(location)) {
    throw new Error('Speech-to-Text V1 location must be global, us, or eu');
  }
  return location === 'global' ? 'speech.googleapis.com' : `${location}-speech.googleapis.com`;
}

export function speechV2Endpoint(location: string): string {
  assertLocation(location);
  return location === 'global' ? 'speech.googleapis.com' : `${location}-speech.googleapis.com`;
}

export function textToSpeechEndpoint(location: string): string {
  if (!TTS_LOCATIONS.has(location)) {
    throw new Error('Text-to-Speech location must be global, us, eu, or us-central1');
  }
  return location === 'global'
    ? 'texttospeech.googleapis.com'
    : `${location}-texttospeech.googleapis.com`;
}

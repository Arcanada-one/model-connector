import type { DeepgramTtsRequest } from './deepgram-tts.types';

const DEFAULT_HTTP_BASE = 'https://api.deepgram.com';
const ALLOWED_PROTOCOLS = new Set(['https:', 'wss:']);

export function buildDeepgramSpeakUrl(
  request: Pick<
    DeepgramTtsRequest,
    'model' | 'encoding' | 'sampleRate' | 'container' | 'bitRate' | 'baseUrl'
  >,
  transport: 'http' | 'websocket',
): string {
  if (!request.model.trim()) throw new TypeError('Deepgram Aura model is required');
  const requestedBase = request.baseUrl ?? DEFAULT_HTTP_BASE;
  const url = new URL(requestedBase);
  if (!ALLOWED_PROTOCOLS.has(url.protocol))
    throw new TypeError('Deepgram base URL must use HTTPS or WSS');
  url.protocol = transport === 'websocket' ? 'wss:' : 'https:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/speak`;
  url.search = '';
  url.searchParams.set('model', request.model);
  if (request.encoding) url.searchParams.set('encoding', request.encoding);
  if (request.sampleRate !== undefined)
    url.searchParams.set('sample_rate', String(request.sampleRate));
  if (request.container) url.searchParams.set('container', request.container);
  if (request.bitRate !== undefined) url.searchParams.set('bit_rate', String(request.bitRate));
  return url.toString();
}

export function deepgramAuthorization(auth: DeepgramTtsRequest['auth']): string {
  if (!auth.credential.trim()) throw new TypeError('Deepgram credential is required');
  return `${auth.type === 'api-key' ? 'Token' : 'Bearer'} ${auth.credential}`;
}

export function deepgramWebSocketProtocols(auth: DeepgramTtsRequest['auth']): string[] {
  if (!auth.credential.trim()) throw new TypeError('Deepgram credential is required');
  return [auth.type === 'api-key' ? 'token' : 'bearer', auth.credential];
}

export type DeepgramAuth =
  | { type: 'api-key'; credential: string }
  | { type: 'bearer'; credential: string };

export interface DeepgramTtsRequest {
  text: string;
  model: string;
  encoding?: string;
  sampleRate?: number;
  container?: string;
  bitRate?: number;
  baseUrl?: string;
  auth: DeepgramAuth;
}

export interface DeepgramTtsHttpResult {
  audio: Uint8Array;
  contentType?: string;
  requestId?: string;
}

export type DeepgramTtsEvent =
  | { type: 'Audio'; audio: Uint8Array }
  | ({ type: 'Metadata' | 'Flushed' | 'Cleared' | 'Warning' } & Record<string, unknown>);

export interface DeepgramWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(name: string, listener: (event: unknown) => void): void;
}

export type DeepgramWebSocketFactory = (url: string, protocols: string[]) => DeepgramWebSocket;

export interface GoogleSpeechHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface GoogleSpeechHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface GoogleSpeechHttpTransport {
  request(request: GoogleSpeechHttpRequest): Promise<GoogleSpeechHttpResponse>;
}

export interface GoogleSpeechStreamRequest {
  endpoint: string;
  service: string;
  method: string;
  metadata: Record<string, string>;
  requests: AsyncIterable<unknown>;
}

export interface GoogleSpeechStreamingTransport {
  stream(request: GoogleSpeechStreamRequest): AsyncIterable<unknown>;
}

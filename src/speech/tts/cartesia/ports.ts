export interface CartesiaHttpRequest {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface CartesiaHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface CartesiaHttpPort {
  request(request: CartesiaHttpRequest): Promise<CartesiaHttpResponse>;
}

export interface CartesiaWebSocketLike {
  send(data: string): void;
  close(): void;
}

export interface CartesiaWebSocketPort {
  connect(options: {
    url: string;
    headers: Record<string, string>;
  }): Promise<CartesiaWebSocketLike>;
}

export type AwsSpeechService = 'transcribe' | 'polly';

export interface AwsSigningScope {
  region: string;
  service: AwsSpeechService;
}

export interface UnsignedAwsHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface SignedAwsHttpRequest extends UnsignedAwsHttpRequest {}

export interface AwsHttpResponse {
  statusCode: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}

export interface AwsEventStreamFrame {
  payload: Uint8Array;
  priorSignature: string;
  signature?: string;
}

export interface SignedAwsEventStreamFrame extends AwsEventStreamFrame {
  signature: string;
}

export interface AwsSpeechSigner {
  signHttp(request: UnsignedAwsHttpRequest, scope: AwsSigningScope): Promise<SignedAwsHttpRequest>;
  presignWebSocket(
    request: UnsignedAwsHttpRequest,
    scope: AwsSigningScope & { expiresInSeconds: number },
  ): Promise<SignedAwsHttpRequest>;
  signEventFrame(
    frame: AwsEventStreamFrame,
    scope: AwsSigningScope,
  ): Promise<SignedAwsEventStreamFrame>;
}

export interface AwsSpeechHttpTransport {
  send(request: SignedAwsHttpRequest): Promise<AwsHttpResponse>;
}

export interface AwsTranscribeStreamInput {
  protocol: 'http2' | 'websocket';
  handshake: SignedAwsHttpRequest;
  audio: AsyncIterable<Uint8Array>;
  signFrame(frame: AwsEventStreamFrame): Promise<SignedAwsEventStreamFrame>;
}

export type AwsTranscribeStreamEvent =
  | {
      type: 'transcript';
      requestId?: string;
      Transcript: {
        Results: Array<{
          ResultId?: string;
          IsPartial: boolean;
          StartTime?: number;
          EndTime?: number;
          Alternatives: Array<{ Transcript: string; [key: string]: unknown }>;
          [key: string]: unknown;
        }>;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }
  | {
      type: 'exception';
      code: string;
      message: string;
      requestId?: string;
      [key: string]: unknown;
    }
  | {
      type: 'end';
      requestId?: string;
      [key: string]: unknown;
    };

export interface AwsTranscribeEventStreamTransport {
  stream(input: AwsTranscribeStreamInput): AsyncIterable<unknown>;
}

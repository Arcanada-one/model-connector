export type HumeAuth =
  | { apiKey: string; accessToken?: never }
  | { apiKey?: never; accessToken: string };

export interface HumeHttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface HumeHttpResponse {
  status: number;
  body: unknown;
}

export type HumeHttpTransport = (request: HumeHttpRequest) => Promise<HumeHttpResponse>;

export interface HumeSocket {
  send(data: string): void;
}

export interface HumePagination {
  pageNumber?: number;
  pageSize?: number;
  ascendingOrder?: boolean;
}

export interface HumeChatOptions {
  configId?: string;
  configVersion?: number;
  resumedChatGroupId?: string;
  verboseTranscription?: boolean;
  allowConnection?: boolean;
}

export type HumeFrame = Record<string, unknown>;

export interface HumeFrameHandlers {
  verboseTranscription?: boolean;
  onFrame(frame: HumeFrame): void;
  onStopPlayback?(frame: HumeFrame): void;
}

export type HumeAuth =
  | { apiKey: string; accessToken?: never }
  | { apiKey?: never; accessToken: string };

/**
 * A2-299 — what a CALLER may hand in, before `assertAuth` has looked at it.
 *
 * {@link HumeAuth} makes "neither credential" and "both credentials"
 * unrepresentable, and those are precisely the two states the connector's
 * runtime guard exists to reject. So the guard was unreachable from any
 * correctly-typed caller: the public methods were typed as if their input had
 * already been validated while still carrying a validator for input that had
 * not. The type check noticed — the spec asserting the rejection could not name
 * its own inputs — and the honest fix is to accept the untrusted shape at the
 * boundary and let the guard narrow it, rather than to cast at the call site.
 */
export type HumeAuthInput = { apiKey?: string; accessToken?: string };

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

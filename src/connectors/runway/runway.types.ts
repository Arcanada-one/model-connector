export type RunwayOperation =
  | 'image_to_video'
  | 'text_to_video'
  | 'video_to_video'
  | 'text_to_image'
  | 'image_upscale'
  | 'video_upscale'
  | 'character_performance'
  | 'sound_effect'
  | 'speech_to_speech'
  | 'text_to_speech'
  | 'voice_dubbing'
  | 'voice_isolation';

export type RunwayHeaders = Readonly<Record<string, string>>;
export type RunwayNativeBody = Readonly<Record<string, unknown>>;

export interface RunwayHttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers: RunwayHeaders;
  body?: RunwayNativeBody;
}

export interface RunwayHttpResponse<T = unknown> {
  status: number;
  data?: T;
}

export interface RunwayHttpTransport {
  request<T>(request: RunwayHttpRequest): Promise<RunwayHttpResponse<T>>;
}

export interface RunwayTaskCreated {
  id: string;
  [key: string]: unknown;
}

interface RunwayTaskBase {
  id: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface RunwayPendingTask extends RunwayTaskBase {
  status: 'PENDING';
}

export interface RunwayThrottledTask extends RunwayTaskBase {
  status: 'THROTTLED';
}

export interface RunwayRunningTask extends RunwayTaskBase {
  status: 'RUNNING';
  progress?: number;
}

export interface RunwaySucceededTask extends RunwayTaskBase {
  status: 'SUCCEEDED';
  output: string[];
}

export interface RunwayFailedTask extends RunwayTaskBase {
  status: 'FAILED';
  failure: string;
  failureCode?: string | null;
}

export interface RunwayCancelledTask extends RunwayTaskBase {
  status: 'CANCELLED';
}

export type RunwayTask =
  | RunwayPendingTask
  | RunwayThrottledTask
  | RunwayRunningTask
  | RunwaySucceededTask
  | RunwayFailedTask
  | RunwayCancelledTask;

export interface RunwayEphemeralUploadTicket {
  uploadUrl: string;
  fields: Record<string, unknown>;
  runwayUri: string;
  [key: string]: unknown;
}

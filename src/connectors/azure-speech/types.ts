export type AzureSpeechResourceKeyAuthentication = {
  kind: 'resource-key';
  key: string;
};

export type AzureSpeechMicrosoftEntraAuthentication = {
  kind: 'microsoft-entra';
  resourceId: string;
  accessToken: string;
};

export type AzureSpeechAuthentication =
  | AzureSpeechResourceKeyAuthentication
  | AzureSpeechMicrosoftEntraAuthentication;

export type AzureSpeechPublicRegionDeployment = {
  kind: 'public-region';
  region: string;
};

export type AzureSpeechResourceEndpointDeployment = {
  kind: 'resource-endpoint';
  endpoint: string;
  networkAccess: 'all-networks' | 'restricted';
};

export type AzureSpeechDeployment =
  | AzureSpeechPublicRegionDeployment
  | AzureSpeechResourceEndpointDeployment;

export type AzureSpeechHttpTransport = (input: string, init: RequestInit) => Promise<Response>;

export type AzureSpeechDelay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export type AzureSpeechStreamingAudioContentType =
  | 'audio/wav; codecs=audio/pcm; samplerate=16000'
  | 'audio/ogg; codecs=opus';

export type AzureSpeechRecognitionEvent =
  | {
      kind: 'recognizing';
      text: string;
      providerEvent?: unknown;
    }
  | {
      kind: 'recognized';
      text: string;
      providerEvent?: unknown;
    }
  | {
      kind: 'error';
      code: string;
      message: string;
      providerEvent?: unknown;
    };

export interface AzureSpeechStreamingConnectInput {
  url: string;
  authentication: AzureSpeechAuthentication;
  contentType: AzureSpeechStreamingAudioContentType;
  audio: AsyncIterable<Uint8Array>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AzureSpeechStreamingTransport {
  connect(input: AzureSpeechStreamingConnectInput): AsyncIterable<AzureSpeechRecognitionEvent>;
}

export interface AzureSpeechConnectorOptions {
  deployment: AzureSpeechDeployment;
  authentication: AzureSpeechAuthentication;
  httpTransport: AzureSpeechHttpTransport;
  streamingTransport: AzureSpeechStreamingTransport;
  delay?: AzureSpeechDelay;
}

export interface AzureSpeechFastTranscriptionInput {
  audio: Uint8Array;
  filename: string;
  mimeType: string;
  definition: Record<string, unknown>;
  durationSeconds?: number;
  signal?: AbortSignal;
}

export interface AzureSpeechBatchTranscriptionInput {
  displayName: string;
  locale: string;
  properties: Record<string, unknown> & {
    timeToLiveHours?: number;
  };
  contentUrls?: string[];
  contentContainerUrl?: string;
  customProperties?: Record<string, string>;
  description?: string;
  model?: Record<string, unknown>;
  project?: Record<string, unknown>;
  dataset?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AzureSpeechBatchSubmitResult {
  transcription: Record<string, unknown>;
  location: string;
}

export interface AzureSpeechBatchPollingOptions {
  maxAttempts: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface AzureSpeechStreamingTranscriptionInput {
  locale: string;
  outputFormat: 'simple' | 'detailed';
  contentType: AzureSpeechStreamingAudioContentType;
  customEndpointId?: string;
  audio: AsyncIterable<Uint8Array>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AzureSpeechSynthesisInput {
  ssml: string;
  outputFormat: string;
  userAgent: string;
  signal?: AbortSignal;
}

export interface AzureSpeechSynthesisResult {
  audio: Uint8Array;
  contentType: string | null;
}

export type AzureSpeechVoice = Record<string, unknown>;

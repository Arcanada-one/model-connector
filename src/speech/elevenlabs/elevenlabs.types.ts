export interface BinaryResponse {
  data: ArrayBuffer | null;
  stream: ReadableStream<Uint8Array> | null;
  contentType: string | null;
  requestId: string | null;
  characterCost: number | null;
}

export interface TextToSpeechRequest {
  voiceId: string;
  text: string;
  modelId?: string;
  outputFormat?: string;
}

export interface SpeechToSpeechRequest {
  voiceId: string;
  audio: Blob;
  modelId?: string;
  removeBackgroundNoise?: boolean;
  outputFormat?: string;
}

export interface SpeechToTextRequest {
  file: Blob;
  modelId?: string;
  diarize?: boolean;
}

export interface DubbingCreateRequest {
  file: Blob;
  targetLanguage: string;
  name?: string;
}

export interface QueryValueMap {
  [key: string]: string | number | boolean | undefined;
}

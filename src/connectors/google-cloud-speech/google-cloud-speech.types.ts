export type JsonObject = Record<string, unknown>;

export interface GoogleAuthHeadersProvider {
  getRequestHeaders(): Promise<Record<string, string>>;
}

export interface RecognitionAudio {
  content?: string;
  uri?: string;
}

export interface RecognitionConfig extends JsonObject {
  languageCode?: string;
  languageCodes?: string[];
}

export interface SpeechRecognitionAlternative extends JsonObject {
  transcript?: string;
  confidence?: number;
}

export interface SpeechRecognitionResult extends JsonObject {
  alternatives?: SpeechRecognitionAlternative[];
  languageCode?: string;
}

export interface RecognizeResponse extends JsonObject {
  results?: SpeechRecognitionResult[];
}

export interface V1RecognizeInput {
  config: RecognitionConfig;
  audio: RecognitionAudio;
  audioDurationSeconds: number;
}

export interface V1StreamingRecognizeRequest {
  streamingConfig?: JsonObject;
  audioContent?: string;
}

export interface V1StreamingRecognizeResponse extends JsonObject {
  results?: SpeechRecognitionResult[];
}

export interface V2RecognizeInput {
  recognizer: string;
  config?: RecognitionConfig;
  configMask?: string;
  audio: RecognitionAudio;
  audioDurationSeconds: number;
}

export interface BatchRecognizeFileReference {
  uri: string;
  audioDurationSeconds: number;
}

export interface GcsRecognitionOutputConfig extends JsonObject {
  uri: string;
}

export interface RecognitionOutputConfig extends JsonObject {
  gcsOutputConfig?: GcsRecognitionOutputConfig;
  inlineResponseConfig?: JsonObject;
  outputFormatConfig?: JsonObject;
}

export interface V2BatchRecognizeInput {
  recognizer: string;
  config?: RecognitionConfig;
  configMask?: string;
  files: BatchRecognizeFileReference[];
  recognitionOutputConfig: RecognitionOutputConfig;
  processingStrategy?: string;
}

export interface V2StreamingRecognizeRequest {
  recognizer?: string;
  streamingConfig?: JsonObject;
  audio?: string;
}

export interface V2StreamingRecognizeResponse extends JsonObject {
  results?: SpeechRecognitionResult[];
}

export interface SynthesisInput {
  text?: string;
  ssml?: string;
}

export interface VoiceSelectionParams extends JsonObject {
  languageCode: string;
  name?: string;
}

export type UnaryAudioEncoding = 'LINEAR16' | 'MP3' | 'OGG_OPUS' | 'MULAW' | 'ALAW';
export type StreamingAudioEncoding = 'PCM' | 'ALAW' | 'MULAW' | 'OGG_OPUS';

export interface AudioConfig extends JsonObject {
  audioEncoding: string;
}

export interface StreamingAudioConfig extends JsonObject {
  audioEncoding: string;
}

export interface SynthesizeV1Input {
  input: SynthesisInput;
  voice: VoiceSelectionParams;
  audioConfig: AudioConfig;
}

export interface SynthesizeSpeechResponse extends JsonObject {
  audioContent: string;
}

export interface Voice extends JsonObject {
  languageCodes: string[];
  name: string;
  ssmlGender: string;
  naturalSampleRateHertz: number;
}

export interface ListVoicesResponse extends JsonObject {
  voices?: Voice[];
}

export interface SynthesizeLongAudioInput {
  parent: string;
  input: SynthesisInput;
  voice: VoiceSelectionParams;
  audioConfig: AudioConfig;
  outputGcsUri: string;
  version?: 'v1' | 'v1beta1';
}

export interface StreamingSynthesizeRequest {
  streamingConfig?: {
    voice: VoiceSelectionParams;
    streamingAudioConfig: StreamingAudioConfig;
  };
  input?: SynthesisInput;
}

export interface StreamingSynthesizeResponse extends JsonObject {
  audioContent: string;
}

export interface GoogleRpcStatus {
  code: number;
  message: string;
  details?: JsonObject[];
}

export interface GoogleLongRunningOperation {
  name: string;
  metadata?: JsonObject;
  done?: boolean;
  error?: GoogleRpcStatus;
  response?: JsonObject;
}

export interface GoogleApiErrorBody {
  error: {
    code: number;
    message: string;
    status?: string;
    details?: JsonObject[];
  };
}

export type GoogleSpeechOperationApi = 'speech-v1' | 'speech-v2' | 'tts-v1' | 'tts-v1beta1';

export interface GoogleSpeechOperationReference {
  api: GoogleSpeechOperationApi;
  name: string;
  location?: string;
}

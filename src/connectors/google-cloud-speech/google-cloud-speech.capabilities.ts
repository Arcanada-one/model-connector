export type GoogleSpeechProtocol = 'rest' | 'grpc';
export type GoogleSpeechReleaseStage = 'stable' | 'beta' | 'preview';

export interface GoogleSpeechOperationCapability {
  id: string;
  service: 'speech-to-text' | 'text-to-speech';
  protocol: GoogleSpeechProtocol;
  apiVersion: 'v1' | 'v2' | 'v1beta1';
  releaseStage: GoogleSpeechReleaseStage;
  method?: 'GET' | 'POST';
  path?: string;
  rpc?: string;
}

const operations: GoogleSpeechOperationCapability[] = [
  {
    id: 'stt.v1.recognize',
    service: 'speech-to-text',
    protocol: 'rest',
    apiVersion: 'v1',
    releaseStage: 'stable',
    method: 'POST',
    path: '/v1/speech:recognize',
  },
  {
    id: 'stt.v1.longRunningRecognize',
    service: 'speech-to-text',
    protocol: 'rest',
    apiVersion: 'v1',
    releaseStage: 'stable',
    method: 'POST',
    path: '/v1/speech:longrunningrecognize',
  },
  {
    id: 'stt.v1.streamingRecognize',
    service: 'speech-to-text',
    protocol: 'grpc',
    apiVersion: 'v1',
    releaseStage: 'stable',
    rpc: 'google.cloud.speech.v1.Speech/StreamingRecognize',
  },
  {
    id: 'stt.v1.operations.get',
    service: 'speech-to-text',
    protocol: 'rest',
    apiVersion: 'v1',
    releaseStage: 'stable',
    method: 'GET',
    path: '/v1/operations/{name=**}',
  },
  {
    id: 'stt.v1.operations.cancel',
    service: 'speech-to-text',
    protocol: 'rest',
    apiVersion: 'v1',
    releaseStage: 'stable',
    method: 'POST',
    path: '/v1/operations/{name=**}:cancel',
  },
  {
    id: 'stt.v2.recognize',
    service: 'speech-to-text',
    protocol: 'rest',
    apiVersion: 'v2',
    releaseStage: 'stable',
    method: 'POST',
    path: '/v2/{recognizer}:recognize',
  },
  {
    id: 'stt.v2.batchRecognize',
    service: 'speech-to-text',
    protocol: 'rest',
    apiVersion: 'v2',
    releaseStage: 'stable',
    method: 'POST',
    path: '/v2/{recognizer}:batchRecognize',
  },
  {
    id: 'stt.v2.streamingRecognize',
    service: 'speech-to-text',
    protocol: 'grpc',
    apiVersion: 'v2',
    releaseStage: 'stable',
    rpc: 'google.cloud.speech.v2.Speech/StreamingRecognize',
  },
  {
    id: 'stt.v2.operations.get',
    service: 'speech-to-text',
    protocol: 'rest',
    apiVersion: 'v2',
    releaseStage: 'stable',
    method: 'GET',
    path: '/v2/{name=projects/*/locations/*/operations/*}',
  },
  {
    id: 'stt.v2.operations.cancel',
    service: 'speech-to-text',
    protocol: 'rest',
    apiVersion: 'v2',
    releaseStage: 'stable',
    method: 'POST',
    path: '/v2/{name=projects/*/locations/*/operations/*}:cancel',
  },
  {
    id: 'tts.v1.synthesize',
    service: 'text-to-speech',
    protocol: 'rest',
    apiVersion: 'v1',
    releaseStage: 'stable',
    method: 'POST',
    path: '/v1/text:synthesize',
  },
  {
    id: 'tts.v1.voices.list',
    service: 'text-to-speech',
    protocol: 'rest',
    apiVersion: 'v1',
    releaseStage: 'stable',
    method: 'GET',
    path: '/v1/voices',
  },
  {
    id: 'tts.v1.synthesizeLongAudio',
    service: 'text-to-speech',
    protocol: 'rest',
    apiVersion: 'v1',
    releaseStage: 'stable',
    method: 'POST',
    path: '/v1/{parent=projects/*/locations/*}:synthesizeLongAudio',
  },
  {
    id: 'tts.v1.streamingSynthesize',
    service: 'text-to-speech',
    protocol: 'grpc',
    apiVersion: 'v1',
    releaseStage: 'preview',
    rpc: 'google.cloud.texttospeech.v1.TextToSpeech/StreamingSynthesize',
  },
  {
    id: 'tts.v1.operations.get',
    service: 'text-to-speech',
    protocol: 'rest',
    apiVersion: 'v1',
    releaseStage: 'stable',
    method: 'GET',
    path: '/v1/{name=projects/*/locations/*/operations/*}',
  },
  {
    id: 'tts.v1.operations.cancel',
    service: 'text-to-speech',
    protocol: 'rest',
    apiVersion: 'v1',
    releaseStage: 'stable',
    method: 'POST',
    path: '/v1/{name=projects/*/locations/*/operations/*}:cancel',
  },
  {
    id: 'tts.v1beta1.synthesizeLongAudio',
    service: 'text-to-speech',
    protocol: 'rest',
    apiVersion: 'v1beta1',
    releaseStage: 'beta',
    method: 'POST',
    path: '/v1beta1/{parent=projects/*/locations/*}:synthesizeLongAudio',
  },
  {
    id: 'tts.v1beta1.operations.get',
    service: 'text-to-speech',
    protocol: 'rest',
    apiVersion: 'v1beta1',
    releaseStage: 'beta',
    method: 'GET',
    path: '/v1beta1/{name=projects/*/locations/*/operations/*}',
  },
  {
    id: 'tts.v1beta1.operations.cancel',
    service: 'text-to-speech',
    protocol: 'rest',
    apiVersion: 'v1beta1',
    releaseStage: 'beta',
    method: 'POST',
    path: '/v1beta1/{name=projects/*/locations/*/operations/*}:cancel',
  },
];

export const GOOGLE_CLOUD_SPEECH_CAPABILITIES = {
  provider: 'google-cloud-speech',
  endpoints: {
    speechToTextV1: ['global', 'us', 'eu'],
    speechToTextV2: 'location-prefixed-or-global',
    textToSpeech: ['global', 'us', 'eu', 'us-central1'],
  },
  operations,
} as const;

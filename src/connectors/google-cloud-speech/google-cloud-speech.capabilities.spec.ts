import { describe, expect, it } from 'vitest';
import { GOOGLE_CLOUD_SPEECH_CAPABILITIES } from './google-cloud-speech.capabilities';

const expectedOperationIds = [
  'stt.v1.recognize',
  'stt.v1.longRunningRecognize',
  'stt.v1.streamingRecognize',
  'stt.v1.operations.get',
  'stt.v1.operations.cancel',
  'stt.v2.recognize',
  'stt.v2.batchRecognize',
  'stt.v2.streamingRecognize',
  'stt.v2.operations.get',
  'stt.v2.operations.cancel',
  'tts.v1.synthesize',
  'tts.v1.voices.list',
  'tts.v1.synthesizeLongAudio',
  'tts.v1.streamingSynthesize',
  'tts.v1.operations.get',
  'tts.v1.operations.cancel',
  'tts.v1beta1.synthesizeLongAudio',
  'tts.v1beta1.operations.get',
  'tts.v1beta1.operations.cancel',
];

describe('GOOGLE_CLOUD_SPEECH_CAPABILITIES', () => {
  it('declares the complete AU-045 operation boundary without an unsupported catalog', () => {
    expect(GOOGLE_CLOUD_SPEECH_CAPABILITIES.provider).toBe('google-cloud-speech');
    expect(GOOGLE_CLOUD_SPEECH_CAPABILITIES.operations.map(({ id }) => id)).toEqual(
      expectedOperationIds,
    );
    expect(JSON.stringify(GOOGLE_CLOUD_SPEECH_CAPABILITIES)).not.toMatch(
      /Gemini|Vertex|Media Translation|voiceCatalog|modelCatalog/i,
    );
  });

  it('keeps REST and gRPC-only operation protocols explicit', () => {
    const byId = Object.fromEntries(
      GOOGLE_CLOUD_SPEECH_CAPABILITIES.operations.map((operation) => [operation.id, operation]),
    );
    expect(byId['stt.v1.recognize']).toMatchObject({
      protocol: 'rest',
      apiVersion: 'v1',
      releaseStage: 'stable',
      method: 'POST',
      path: '/v1/speech:recognize',
    });
    expect(byId['stt.v2.streamingRecognize']).toMatchObject({
      protocol: 'grpc',
      apiVersion: 'v2',
      releaseStage: 'stable',
    });
    expect(byId['stt.v1.operations.get']?.path).toBe('/v1/operations/{name=**}');
    expect(byId['stt.v1.operations.cancel']?.path).toBe('/v1/operations/{name=**}:cancel');
  });

  it('labels beta and Preview surfaces without promoting either to stable', () => {
    const byId = Object.fromEntries(
      GOOGLE_CLOUD_SPEECH_CAPABILITIES.operations.map((operation) => [operation.id, operation]),
    );
    expect(byId['tts.v1beta1.synthesizeLongAudio']?.releaseStage).toBe('beta');
    expect(byId['tts.v1.streamingSynthesize']?.releaseStage).toBe('preview');
    expect(byId['tts.v1.synthesizeLongAudio']?.releaseStage).toBe('stable');
  });

  it('records endpoint geography separately for STT V1, STT V2, and TTS', () => {
    expect(GOOGLE_CLOUD_SPEECH_CAPABILITIES.endpoints).toEqual({
      speechToTextV1: ['global', 'us', 'eu'],
      speechToTextV2: 'location-prefixed-or-global',
      textToSpeech: ['global', 'us', 'eu', 'us-central1'],
    });
  });
});

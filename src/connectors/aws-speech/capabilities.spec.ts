import { describe, expect, it } from 'vitest';
import { AWS_SPEECH_CAPABILITIES } from './capabilities';

describe('AWS_SPEECH_CAPABILITIES', () => {
  it('declares every AU-046 family and no adjacent AWS product', () => {
    expect(AWS_SPEECH_CAPABILITIES.provider).toBe('aws-speech');
    expect(AWS_SPEECH_CAPABILITIES.allocationUnit).toBe('AU-046');
    expect(AWS_SPEECH_CAPABILITIES.operations).toEqual([
      'transcribe',
      'streamTranscription',
      'startTranscriptionJob',
      'getTranscriptionJob',
      'listTranscriptionJobs',
      'deleteTranscriptionJob',
      'synthesizeSpeech',
      'startSpeechSynthesisTask',
      'getSpeechSynthesisTask',
      'listSpeechSynthesisTasks',
      'describeVoices',
      'listLexicons',
      'getLexicon',
    ]);
    expect(JSON.stringify(AWS_SPEECH_CAPABILITIES)).not.toMatch(
      /Medical|CallAnalytics|Bedrock|Nova|StartSpeechSynthesisStream/,
    );
  });

  it('records lifecycle absences and provider-native sync semantics honestly', () => {
    expect(AWS_SPEECH_CAPABILITIES.transcribe.synchronous).toEqual({
      providerNativeMode: 'streaming',
      nativeOperation: 'StartStreamTranscription',
      adapter: 'finite-stream',
    });
    expect(AWS_SPEECH_CAPABILITIES.unsupportedOperations).toEqual([
      'cancelTranscriptionJob',
      'cancelSpeechSynthesisTask',
      'deleteSpeechSynthesisTask',
    ]);
    expect(AWS_SPEECH_CAPABILITIES.polly.taskRecordRetentionHours).toBe(72);
    expect(AWS_SPEECH_CAPABILITIES.polly.synchronousMaxOutputMinutes).toBe(10);
    expect(AWS_SPEECH_CAPABILITIES.transcribe.serviceManagedUriTtlMinutes).toBe(15);
    expect(AWS_SPEECH_CAPABILITIES.transcribe.batchMaxAudioSeconds).toBe(28_800);
    expect(AWS_SPEECH_CAPABILITIES.transcribe.batchMaxAudioSizeGb).toBe(2);
  });
});

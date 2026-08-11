import { describe, expect, it } from 'vitest';
import {
  describeVoicesResponseSchema,
  speechSynthesisTaskListRequestSchema,
  speechSynthesisTaskResponseSchema,
  startSpeechSynthesisTaskRequestSchema,
  startTranscriptionJobRequestSchema,
  streamTranscriptionRequestSchema,
  synthesizeSpeechRequestSchema,
  transcriptionJobListRequestSchema,
  transcriptionJobResponseSchema,
} from './schemas';

describe('AWS Speech runtime schemas', () => {
  it('accepts native streaming formats and exactly one language mode', () => {
    expect(
      streamTranscriptionRequestSchema.parse({
        protocol: 'http2',
        languageCode: 'en-US',
        mediaEncoding: 'pcm',
        sampleRateHertz: 16000,
      }),
    ).toMatchObject({ mediaEncoding: 'pcm', sampleRateHertz: 16000 });

    expect(() =>
      streamTranscriptionRequestSchema.parse({
        protocol: 'websocket',
        languageCode: 'en-US',
        identifyLanguage: true,
        mediaEncoding: 'wav',
        sampleRateHertz: 7999,
      }),
    ).toThrow();
  });

  it('keeps channel and PII options mutually valid', () => {
    expect(() =>
      streamTranscriptionRequestSchema.parse({
        protocol: 'http2',
        identifyLanguage: true,
        mediaEncoding: 'flac',
        sampleRateHertz: 48000,
        enableChannelIdentification: true,
      }),
    ).toThrow('numberOfChannels');
    expect(() =>
      streamTranscriptionRequestSchema.parse({
        protocol: 'http2',
        identifyLanguage: true,
        mediaEncoding: 'flac',
        sampleRateHertz: 48000,
        enableChannelIdentification: true,
        numberOfChannels: 3,
      }),
    ).toThrow();
    expect(() =>
      streamTranscriptionRequestSchema.parse({
        protocol: 'http2',
        identifyLanguage: true,
        mediaEncoding: 'flac',
        sampleRateHertz: 48000,
        contentIdentificationType: 'PII',
        contentRedactionType: 'PII',
      }),
    ).toThrow('Content');
  });

  it('validates batch media, S3 input, and language selection', () => {
    expect(
      startTranscriptionJobRequestSchema.parse({
        transcriptionJobName: 'job-1',
        mediaFileUri: 's3://input-bucket/audio.webm',
        mediaFormat: 'webm',
        identifyMultipleLanguages: true,
        languageOptions: ['en-US', 'de-DE'],
        outputBucketName: 'output-bucket',
        outputKey: 'transcripts/',
      }),
    ).toMatchObject({ mediaFormat: 'webm' });
    expect(() =>
      startTranscriptionJobRequestSchema.parse({
        transcriptionJobName: 'bad name',
        mediaFileUri: 'https://example.test/audio.wav',
        languageCode: 'en-US',
      }),
    ).toThrow();
  });

  it('enforces native list page sizes while preserving opaque tokens', () => {
    expect(
      transcriptionJobListRequestSchema.parse({
        maxResults: 100,
        nextToken: 'opaque/transcribe/token',
        status: 'COMPLETED',
      }),
    ).toMatchObject({ maxResults: 100 });
    expect(() => transcriptionJobListRequestSchema.parse({ maxResults: 101 })).toThrow();
    expect(
      speechSynthesisTaskListRequestSchema.parse({
        maxResults: 1,
        nextToken: 'opaque-polly-token',
        status: 'inProgress',
      }),
    ).toMatchObject({ status: 'inProgress' });
  });

  it.each([
    ['mp3', '48000'],
    ['ogg_vorbis', '44100'],
    ['ogg_opus', '48000'],
    ['pcm', '16000'],
    ['mulaw', '8000'],
    ['alaw', '8000'],
    ['json', undefined],
  ])('accepts documented Polly %s sample rates', (outputFormat, sampleRate) => {
    expect(
      synthesizeSpeechRequestSchema.parse({
        text: 'hello world',
        voiceId: 'Joanna',
        outputFormat,
        sampleRate,
        speechMarkTypes: outputFormat === 'json' ? ['word'] : undefined,
      }),
    ).toMatchObject({ outputFormat });
  });

  it('rejects Polly format/mark/rate and synchronous text-limit violations', () => {
    expect(() =>
      synthesizeSpeechRequestSchema.parse({
        text: 'x'.repeat(3001),
        voiceId: 'Joanna',
        outputFormat: 'mp3',
        speechMarkTypes: ['word'],
      }),
    ).toThrow();
    expect(() =>
      synthesizeSpeechRequestSchema.parse({
        text: 'hello',
        voiceId: 'Joanna',
        outputFormat: 'pcm',
        sampleRate: '24000',
      }),
    ).toThrow('sampleRate');
  });

  it('enforces async Polly output and 200000/100000 character limits', () => {
    expect(
      startSpeechSynthesisTaskRequestSchema.parse({
        text: 'long text',
        voiceId: 'Joanna',
        outputFormat: 'mp3',
        outputS3BucketName: 'output-bucket',
        outputS3KeyPrefix: 'prefix/',
      }),
    ).toMatchObject({ outputS3BucketName: 'output-bucket' });
    expect(() =>
      startSpeechSynthesisTaskRequestSchema.parse({
        text: 'x'.repeat(100001),
        voiceId: 'Joanna',
        outputFormat: 'mp3',
        outputS3BucketName: 'output-bucket',
      }),
    ).toThrow();
    expect(() =>
      startSpeechSynthesisTaskRequestSchema.parse({
        text: 'long text',
        voiceId: 'Joanna',
        outputFormat: 'mp3',
        sampleRate: '48000',
        outputS3BucketName: 'output-bucket',
      }),
    ).toThrow('sampleRate');
  });

  it('accepts all provider lifecycle states and preserves added fields', () => {
    const transcribe = transcriptionJobResponseSchema.parse({
      TranscriptionJob: {
        TranscriptionJobName: 'job-1',
        TranscriptionJobStatus: 'COMPLETED',
        FutureAwsField: true,
      },
    });
    expect(transcribe.TranscriptionJob.FutureAwsField).toBe(true);

    const polly = speechSynthesisTaskResponseSchema.parse({
      SynthesisTask: {
        TaskId: 'task-1',
        TaskStatus: 'failed',
        FutureAwsField: 'kept',
      },
    });
    expect(polly.SynthesisTask.FutureAwsField).toBe('kept');
  });

  it('preserves provider-native voice engines, languages, and pagination', () => {
    const response = describeVoicesResponseSchema.parse({
      NextToken: 'next-page',
      Voices: [
        {
          Id: 'Joanna',
          Name: 'Joanna',
          Gender: 'Female',
          LanguageCode: 'en-US',
          LanguageName: 'US English',
          AdditionalLanguageCodes: [],
          SupportedEngines: ['standard', 'neural', 'generative'],
          FutureAwsField: 1,
        },
      ],
    });
    expect(response.NextToken).toBe('next-page');
    expect(response.Voices[0]?.SupportedEngines).toEqual(['standard', 'neural', 'generative']);
    expect(response.Voices[0]?.FutureAwsField).toBe(1);
  });
});

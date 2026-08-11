import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AwsSpeechConnector } from './aws-speech.connector';
import { AwsSpeechServiceError } from './errors';
import type {
  AwsEventStreamFrame,
  AwsHttpResponse,
  AwsSpeechSigner,
  AwsTranscribeEventStreamTransport,
  UnsignedAwsHttpRequest,
} from './transports';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/aws-speech', name), 'utf8')) as T;

const jsonResponse = (
  value: unknown,
  statusCode = 200,
  headers: Record<string, string> = {},
): AwsHttpResponse => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...headers },
  body: new TextEncoder().encode(JSON.stringify(value)),
});

const chunks = async function* (...values: Uint8Array[]) {
  yield* values;
};

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
};

describe('AwsSpeechConnector', () => {
  const signer: AwsSpeechSigner = {
    signHttp: vi.fn(async (request: UnsignedAwsHttpRequest) => ({
      ...request,
      headers: { ...request.headers, authorization: 'TEST-SIGNED' },
    })),
    presignWebSocket: vi.fn(async (request: UnsignedAwsHttpRequest) => ({
      ...request,
      url: `${request.url}?X-Amz-Signature=TEST-SIGNED`,
    })),
    signEventFrame: vi.fn(async (frame: AwsEventStreamFrame) => ({
      ...frame,
      signature: 'TEST-FRAME-SIGNATURE',
    })),
  };
  const httpTransport = { send: vi.fn() };
  const eventTransport: AwsTranscribeEventStreamTransport = {
    stream: vi.fn(),
  };
  let connector: AwsSpeechConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new AwsSpeechConnector({
      region: 'us-west-2',
      partition: 'aws',
      signer,
      httpTransport,
      eventStreamTransport: eventTransport,
    });
  });

  it('implements synchronous transcription as a finite native stream adapter', async () => {
    const events = fixture<unknown[]>('transcribe-events.json');
    vi.mocked(eventTransport.stream).mockImplementation(async function* (input) {
      await input.signFrame({ payload: new Uint8Array([1]), priorSignature: 'seed' });
      yield* events;
    });

    const result = await connector.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      protocol: 'http2',
      languageCode: 'en-US',
      mediaEncoding: 'pcm',
      sampleRateHertz: 16000,
    });

    expect(result).toMatchObject({
      text: 'hello world',
      nativeMode: 'streaming',
      nativeOperation: 'StartStreamTranscription',
      requestId: 'req-stream-1',
    });
    expect(result.results).toHaveLength(1);
    expect(signer.signHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://transcribestreaming.us-west-2.amazonaws.com/stream-transcription',
        headers: expect.objectContaining({
          'content-type': 'application/vnd.amazon.eventstream',
          'x-amz-target': 'com.amazonaws.transcribe.Transcribe.StartStreamTranscription',
          'x-amzn-transcribe-language-code': 'en-US',
          'x-amzn-transcribe-media-encoding': 'pcm',
          'x-amzn-transcribe-sample-rate': '16000',
        }),
      }),
      { region: 'us-west-2', service: 'transcribe' },
    );
    expect(signer.signEventFrame).toHaveBeenCalledWith(
      expect.objectContaining({ priorSignature: 'seed' }),
      { region: 'us-west-2', service: 'transcribe' },
    );
  });

  it('exposes native streaming events and uses WebSocket query presigning', async () => {
    const events = fixture<unknown[]>('transcribe-events.json');
    vi.mocked(eventTransport.stream).mockImplementation(async function* () {
      yield* events;
    });

    const received = await collect(
      connector.streamTranscription(
        {
          protocol: 'websocket',
          identifyLanguage: true,
          languageOptions: ['en-US', 'de-DE'],
          mediaEncoding: 'flac',
          sampleRateHertz: 48000,
        },
        chunks(new Uint8Array([4, 5])),
      ),
    );

    expect(received).toEqual(events);
    expect(signer.presignWebSocket).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: expect.stringContaining(
          'wss://transcribestreaming.us-west-2.amazonaws.com:8443/stream-transcription-websocket?',
        ),
      }),
      { expiresInSeconds: 300, region: 'us-west-2', service: 'transcribe' },
    );
    expect(signer.signHttp).not.toHaveBeenCalled();
  });

  it('builds Transcribe batch start/get/list/delete AWS JSON requests', async () => {
    const jobs = fixture<Record<string, unknown>>('transcribe-jobs.json');
    httpTransport.send
      .mockResolvedValueOnce(jsonResponse(jobs.start))
      .mockResolvedValueOnce(jsonResponse(jobs.get))
      .mockResolvedValueOnce(jsonResponse(jobs.list))
      .mockResolvedValueOnce({ statusCode: 200, headers: {}, body: new Uint8Array() });

    await connector.startTranscriptionJob({
      transcriptionJobName: 'job-1',
      mediaFileUri: 's3://input-bucket/audio.flac',
      mediaFormat: 'flac',
      languageCode: 'en-US',
      outputBucketName: 'output-bucket',
      outputKey: 'transcripts/',
    });
    await connector.getTranscriptionJob({ transcriptionJobName: 'job-1' });
    const page = await connector.listTranscriptionJobs({
      maxResults: 100,
      nextToken: 'opaque-token',
      status: 'COMPLETED',
    });
    await connector.deleteTranscriptionJob({ transcriptionJobName: 'job-1' });

    const signed = vi.mocked(signer.signHttp).mock.calls;
    expect(signed.map(([request]) => request.headers['x-amz-target'])).toEqual([
      'com.amazonaws.transcribe.Transcribe.StartTranscriptionJob',
      'com.amazonaws.transcribe.Transcribe.GetTranscriptionJob',
      'com.amazonaws.transcribe.Transcribe.ListTranscriptionJobs',
      'com.amazonaws.transcribe.Transcribe.DeleteTranscriptionJob',
    ]);
    expect(
      signed.every(
        ([request]) => request.url === 'https://transcribe.us-west-2.amazonaws.com/transcribe',
      ),
    ).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(signed[0]?.[0].body))).toEqual(
      expect.objectContaining({
        TranscriptionJobName: 'job-1',
        Media: { MediaFileUri: 's3://input-bucket/audio.flac' },
        OutputBucketName: 'output-bucket',
        OutputKey: 'transcripts/',
      }),
    );
    expect(page).toMatchObject({ NextToken: 'next-transcribe-page' });
  });

  it('returns Polly synchronous bytes and response metadata', async () => {
    const value = fixture<{
      audioBase64: string;
      headers: Record<string, string>;
    }>('polly-synthesis.json');
    httpTransport.send.mockResolvedValueOnce({
      statusCode: 200,
      headers: value.headers,
      body: Uint8Array.from(Buffer.from(value.audioBase64, 'base64')),
    });

    const result = await connector.synthesizeSpeech({
      text: 'hello world',
      voiceId: 'Joanna',
      engine: 'neural',
      outputFormat: 'mp3',
      sampleRate: '24000',
    });

    expect(result).toMatchObject({
      contentType: 'audio/mpeg',
      requestCharacters: 11,
      requestId: 'req-polly-sync',
    });
    expect(Buffer.from(result.audio).toString('base64')).toBe(value.audioBase64);
    expect(signer.signHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://polly.us-west-2.amazonaws.com/v1/speech',
      }),
      { region: 'us-west-2', service: 'polly' },
    );
  });

  it('preserves Polly async task lifecycle and one-page pagination', async () => {
    const tasks = fixture<Record<string, unknown>>('polly-tasks.json');
    httpTransport.send
      .mockResolvedValueOnce(jsonResponse(tasks.start))
      .mockResolvedValueOnce(jsonResponse(tasks.get))
      .mockResolvedValueOnce(jsonResponse(tasks.list));

    const started = await connector.startSpeechSynthesisTask({
      text: 'hello world',
      voiceId: 'Joanna',
      outputFormat: 'mp3',
      outputS3BucketName: 'output-bucket',
      outputS3KeyPrefix: 'prefix/',
    });
    const completed = await connector.getSpeechSynthesisTask({ taskId: 'task-1' });
    const page = await connector.listSpeechSynthesisTasks({
      maxResults: 100,
      status: 'completed',
      nextToken: 'opaque-token',
    });

    expect(started.SynthesisTask.TaskStatus).toBe('scheduled');
    expect(completed.SynthesisTask).toMatchObject({
      TaskStatus: 'completed',
      OutputUri: 's3://output-bucket/prefix/task-1.mp3',
    });
    expect(page.NextToken).toBe('next-polly-page');
    const urls = vi.mocked(signer.signHttp).mock.calls.map(([request]) => request.url);
    expect(urls).toEqual([
      'https://polly.us-west-2.amazonaws.com/v1/synthesisTasks',
      'https://polly.us-west-2.amazonaws.com/v1/synthesisTasks/task-1',
      'https://polly.us-west-2.amazonaws.com/v1/synthesisTasks?MaxResults=100&NextToken=opaque-token&Status=completed',
    ]);
  });

  it('preserves provider-native voice and lexicon discovery', async () => {
    const discovery = fixture<Record<string, unknown>>('polly-discovery.json');
    httpTransport.send
      .mockResolvedValueOnce(jsonResponse(discovery.voices))
      .mockResolvedValueOnce(jsonResponse(discovery.lexicons))
      .mockResolvedValueOnce(jsonResponse(discovery.lexicon));

    const voices = await connector.describeVoices({
      engine: 'generative',
      languageCode: 'en-US',
      includeAdditionalLanguageCodes: true,
      nextToken: 'voice-token',
    });
    const lexicons = await connector.listLexicons({ nextToken: 'lexicon-token' });
    const lexicon = await connector.getLexicon({ lexiconName: 'DomainTerms' });

    expect(voices.Voices[0]).toMatchObject({
      LanguageCode: 'en-US',
      SupportedEngines: ['standard', 'neural', 'generative'],
    });
    expect(lexicons.NextToken).toBe('next-lexicon-page');
    expect(lexicon.Lexicon).toMatchObject({ Name: 'DomainTerms' });
    expect(vi.mocked(signer.signHttp).mock.calls.map(([request]) => request.url)).toEqual([
      'https://polly.us-west-2.amazonaws.com/v1/voices?Engine=generative&IncludeAdditionalLanguageCodes=yes&LanguageCode=en-US&NextToken=voice-token',
      'https://polly.us-west-2.amazonaws.com/v1/lexicons?NextToken=lexicon-token',
      'https://polly.us-west-2.amazonaws.com/v1/lexicons/DomainTerms',
    ]);
  });

  it('normalizes HTTP and event-stream errors without losing AWS details', async () => {
    const errors = fixture<{
      throttled: {
        statusCode: number;
        headers: Record<string, string>;
        body: unknown;
      };
      event: {
        type: 'exception';
        code: string;
        message: string;
        requestId: string;
      };
    }>('errors.json');
    httpTransport.send.mockResolvedValueOnce(
      jsonResponse(errors.throttled.body, errors.throttled.statusCode, errors.throttled.headers),
    );

    await expect(
      connector.synthesizeSpeech({
        text: 'hello',
        voiceId: 'Joanna',
        outputFormat: 'mp3',
      }),
    ).rejects.toMatchObject({
      providerCode: 'ThrottlingException',
      requestId: 'req-throttle',
      retryable: true,
    });

    vi.mocked(eventTransport.stream).mockImplementation(async function* () {
      yield errors.event;
    });
    await expect(
      connector.transcribe({
        audio: new Uint8Array([1]),
        protocol: 'http2',
        languageCode: 'en-US',
        mediaEncoding: 'pcm',
        sampleRateHertz: 16000,
      }),
    ).rejects.toBeInstanceOf(AwsSpeechServiceError);
  });

  it('rejects invalid input before signing or transport dispatch', async () => {
    await expect(
      connector.synthesizeSpeech({
        text: 'hello',
        voiceId: 'Joanna',
        outputFormat: 'pcm',
        sampleRate: '24000',
      }),
    ).rejects.toThrow('sampleRate');
    expect(signer.signHttp).not.toHaveBeenCalled();
    expect(httpTransport.send).not.toHaveBeenCalled();
  });

  it('exposes immutable exact-scope capabilities', () => {
    const capabilities = connector.getCapabilities();
    expect(capabilities.operations).toContain('deleteTranscriptionJob');
    expect(capabilities.unsupportedOperations).toContain('deleteSpeechSynthesisTask');
    expect(Object.isFrozen(capabilities)).toBe(true);
  });
});

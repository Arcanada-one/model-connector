import { AWS_SPEECH_CAPABILITIES } from './capabilities';
import {
  AwsSpeechServiceError,
  AwsSpeechValidationError,
  parseAwsEventStreamError,
  parseAwsHttpError,
} from './errors';
import { resolveAwsSpeechEndpoints, type AwsPartition, type AwsSpeechEndpoints } from './endpoints';
import {
  describeVoicesRequestSchema,
  describeVoicesResponseSchema,
  getLexiconRequestSchema,
  getLexiconResponseSchema,
  listLexiconsRequestSchema,
  listLexiconsResponseSchema,
  speechSynthesisTaskIdRequestSchema,
  speechSynthesisTaskListRequestSchema,
  speechSynthesisTaskListResponseSchema,
  speechSynthesisTaskResponseSchema,
  startSpeechSynthesisTaskRequestSchema,
  startTranscriptionJobRequestSchema,
  streamTranscriptionRequestSchema,
  synthesizeSpeechRequestSchema,
  transcribeRequestSchema,
  transcribeStreamEventSchema,
  transcriptionJobListRequestSchema,
  transcriptionJobListResponseSchema,
  transcriptionJobNameRequestSchema,
  transcriptionJobResponseSchema,
  type StartSpeechSynthesisTaskRequest,
  type StartTranscriptionJobRequest,
  type StreamTranscriptionRequest,
  type SynthesizeSpeechRequest,
  type TranscribeRequest,
} from './schemas';
import type {
  AwsHttpResponse,
  AwsSpeechHttpTransport,
  AwsSpeechService,
  AwsSpeechSigner,
  AwsTranscribeEventStreamTransport,
  AwsTranscribeStreamEvent,
  UnsignedAwsHttpRequest,
} from './transports';
import type { z } from 'zod';

export interface AwsSpeechConnectorOptions {
  region: string;
  partition: AwsPartition;
  signer: AwsSpeechSigner;
  httpTransport: AwsSpeechHttpTransport;
  eventStreamTransport: AwsTranscribeEventStreamTransport;
}

export interface AwsSynchronousTranscriptionResult {
  text: string;
  nativeMode: 'streaming';
  nativeOperation: 'StartStreamTranscription';
  requestId?: string;
  results: Array<
    AwsTranscribeStreamEvent & { type: 'transcript' }
  >[number]['Transcript']['Results'];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

const jsonBytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

const lowerHeader = (
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined => {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
};

const addQuery = (
  base: string,
  entries: Array<[string, string | number | boolean | undefined]>,
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined) query.append(key, String(value));
  }
  const rendered = query.toString();
  return rendered ? `${base}?${rendered}` : base;
};

const oneChunk = async function* (audio: Uint8Array) {
  yield audio;
};

export class AwsSpeechConnector {
  private readonly endpoints: AwsSpeechEndpoints;

  constructor(private readonly options: AwsSpeechConnectorOptions) {
    this.endpoints = resolveAwsSpeechEndpoints(options);
  }

  getCapabilities() {
    return AWS_SPEECH_CAPABILITIES;
  }

  async transcribe(input: TranscribeRequest): Promise<AwsSynchronousTranscriptionResult> {
    const parsed = transcribeRequestSchema.parse(input);
    const { audio, ...streamRequest } = parsed;
    const results: AwsSynchronousTranscriptionResult['results'] = [];
    let requestId: string | undefined;
    let ended = false;

    for await (const event of this.streamTranscription(streamRequest, oneChunk(audio))) {
      requestId = event.requestId ?? requestId;
      if (event.type === 'transcript') {
        results.push(...event.Transcript.Results.filter((result) => !result.IsPartial));
      } else if (event.type === 'end') {
        ended = true;
      }
    }

    if (!ended || results.length === 0) {
      throw new AwsSpeechValidationError('stream ended without a final transcript event');
    }

    return {
      text: results
        .map((result) => result.Alternatives[0]?.Transcript ?? '')
        .filter(Boolean)
        .join(' '),
      nativeMode: 'streaming',
      nativeOperation: 'StartStreamTranscription',
      requestId,
      results,
    };
  }

  async *streamTranscription(
    input: StreamTranscriptionRequest,
    audio: AsyncIterable<Uint8Array>,
  ): AsyncIterable<AwsTranscribeStreamEvent> {
    const parsed = streamTranscriptionRequestSchema.parse(input);
    const handshake = await this.signStreamingHandshake(parsed);
    const scope = { region: this.options.region, service: 'transcribe' as const };
    const source = this.options.eventStreamTransport.stream({
      protocol: parsed.protocol,
      handshake,
      audio,
      signFrame: (frame) => this.options.signer.signEventFrame(frame, scope),
    });

    for await (const rawEvent of source) {
      const event = transcribeStreamEventSchema.parse(rawEvent);
      if (event.type === 'exception') {
        throw parseAwsEventStreamError(event);
      }
      yield event;
    }
  }

  async startTranscriptionJob(input: StartTranscriptionJobRequest) {
    const value = startTranscriptionJobRequestSchema.parse(input);
    return this.sendTranscribeJson(
      'StartTranscriptionJob',
      compact({
        TranscriptionJobName: value.transcriptionJobName,
        Media: { MediaFileUri: value.mediaFileUri },
        MediaFormat: value.mediaFormat,
        MediaSampleRateHertz: value.mediaSampleRateHertz,
        LanguageCode: value.languageCode,
        IdentifyLanguage: value.identifyLanguage,
        IdentifyMultipleLanguages: value.identifyMultipleLanguages,
        LanguageOptions: value.languageOptions,
        OutputBucketName: value.outputBucketName,
        OutputKey: value.outputKey,
        OutputEncryptionKMSKeyId: value.outputEncryptionKmsKeyId,
        Settings: value.settings,
        Subtitles: value.subtitles,
        Tags: value.tags,
      }),
      transcriptionJobResponseSchema,
    );
  }

  async getTranscriptionJob(input: { transcriptionJobName: string }) {
    const value = transcriptionJobNameRequestSchema.parse(input);
    return this.sendTranscribeJson(
      'GetTranscriptionJob',
      { TranscriptionJobName: value.transcriptionJobName },
      transcriptionJobResponseSchema,
    );
  }

  async listTranscriptionJobs(input: {
    jobNameContains?: string;
    maxResults?: number;
    nextToken?: string;
    status?: 'QUEUED' | 'IN_PROGRESS' | 'FAILED' | 'COMPLETED';
  }) {
    const value = transcriptionJobListRequestSchema.parse(input);
    return this.sendTranscribeJson(
      'ListTranscriptionJobs',
      compact({
        JobNameContains: value.jobNameContains,
        MaxResults: value.maxResults,
        NextToken: value.nextToken,
        Status: value.status,
      }),
      transcriptionJobListResponseSchema,
    );
  }

  async deleteTranscriptionJob(input: { transcriptionJobName: string }): Promise<void> {
    const value = transcriptionJobNameRequestSchema.parse(input);
    await this.sendTranscribeJson(
      'DeleteTranscriptionJob',
      { TranscriptionJobName: value.transcriptionJobName },
      undefined,
    );
  }

  async synthesizeSpeech(input: SynthesizeSpeechRequest): Promise<{
    audio: Uint8Array;
    contentType?: string;
    requestCharacters?: number;
    requestId?: string;
  }> {
    const value = synthesizeSpeechRequestSchema.parse(input);
    const response = await this.sendHttp('polly', 'SynthesizeSpeech', {
      method: 'POST',
      url: `${this.endpoints.polly}/v1/speech`,
      headers: { 'content-type': 'application/json' },
      body: jsonBytes(this.pollySynthesisBody(value)),
    });
    const requestCharacters = lowerHeader(response.headers, 'x-amzn-requestcharacters');
    return {
      audio: response.body,
      contentType: lowerHeader(response.headers, 'content-type'),
      requestCharacters:
        requestCharacters === undefined ? undefined : Number.parseInt(requestCharacters, 10),
      requestId: lowerHeader(response.headers, 'x-amzn-requestid'),
    };
  }

  async startSpeechSynthesisTask(input: StartSpeechSynthesisTaskRequest) {
    const value = startSpeechSynthesisTaskRequestSchema.parse(input);
    return this.sendPollyJson(
      'StartSpeechSynthesisTask',
      {
        method: 'POST',
        url: `${this.endpoints.polly}/v1/synthesisTasks`,
        headers: { 'content-type': 'application/json' },
        body: jsonBytes(
          compact({
            ...this.pollySynthesisBody(value),
            OutputS3BucketName: value.outputS3BucketName,
            OutputS3KeyPrefix: value.outputS3KeyPrefix,
            SnsTopicArn: value.snsTopicArn,
          }),
        ),
      },
      speechSynthesisTaskResponseSchema,
    );
  }

  async getSpeechSynthesisTask(input: { taskId: string }) {
    const value = speechSynthesisTaskIdRequestSchema.parse(input);
    return this.sendPollyJson(
      'GetSpeechSynthesisTask',
      {
        method: 'GET',
        url: `${this.endpoints.polly}/v1/synthesisTasks/${encodeURIComponent(value.taskId)}`,
        headers: {},
      },
      speechSynthesisTaskResponseSchema,
    );
  }

  async listSpeechSynthesisTasks(input: {
    maxResults?: number;
    nextToken?: string;
    status?: 'scheduled' | 'inProgress' | 'completed' | 'failed';
  }) {
    const value = speechSynthesisTaskListRequestSchema.parse(input);
    return this.sendPollyJson(
      'ListSpeechSynthesisTasks',
      {
        method: 'GET',
        url: addQuery(`${this.endpoints.polly}/v1/synthesisTasks`, [
          ['MaxResults', value.maxResults],
          ['NextToken', value.nextToken],
          ['Status', value.status],
        ]),
        headers: {},
      },
      speechSynthesisTaskListResponseSchema,
    );
  }

  async describeVoices(input: {
    engine?: 'standard' | 'neural' | 'long-form' | 'generative';
    includeAdditionalLanguageCodes?: boolean;
    languageCode?: string;
    nextToken?: string;
  }) {
    const value = describeVoicesRequestSchema.parse(input);
    return this.sendPollyJson(
      'DescribeVoices',
      {
        method: 'GET',
        url: addQuery(`${this.endpoints.polly}/v1/voices`, [
          ['Engine', value.engine],
          [
            'IncludeAdditionalLanguageCodes',
            value.includeAdditionalLanguageCodes === undefined
              ? undefined
              : value.includeAdditionalLanguageCodes
                ? 'yes'
                : 'no',
          ],
          ['LanguageCode', value.languageCode],
          ['NextToken', value.nextToken],
        ]),
        headers: {},
      },
      describeVoicesResponseSchema,
    );
  }

  async listLexicons(input: { nextToken?: string }) {
    const value = listLexiconsRequestSchema.parse(input);
    return this.sendPollyJson(
      'ListLexicons',
      {
        method: 'GET',
        url: addQuery(`${this.endpoints.polly}/v1/lexicons`, [['NextToken', value.nextToken]]),
        headers: {},
      },
      listLexiconsResponseSchema,
    );
  }

  async getLexicon(input: { lexiconName: string }) {
    const value = getLexiconRequestSchema.parse(input);
    return this.sendPollyJson(
      'GetLexicon',
      {
        method: 'GET',
        url: `${this.endpoints.polly}/v1/lexicons/${encodeURIComponent(value.lexiconName)}`,
        headers: {},
      },
      getLexiconResponseSchema,
    );
  }

  private async signStreamingHandshake(input: StreamTranscriptionRequest) {
    const queryEntries = this.streamingParameters(input);
    const headers = Object.fromEntries(
      queryEntries.map(([key, value]) => [`x-amzn-transcribe-${key}`, String(value)]),
    );
    const scope = { region: this.options.region, service: 'transcribe' as const };

    if (input.protocol === 'websocket') {
      return this.options.signer.presignWebSocket(
        {
          method: 'GET',
          url: addQuery(this.endpoints.transcribeWebSocket, queryEntries),
          headers: {},
        },
        { ...scope, expiresInSeconds: 300 },
      );
    }

    return this.options.signer.signHttp(
      {
        method: 'POST',
        url: this.endpoints.transcribeStreaming,
        headers: {
          'content-type': 'application/vnd.amazon.eventstream',
          'x-amz-target': 'com.amazonaws.transcribe.Transcribe.StartStreamTranscription',
          ...headers,
        },
      },
      scope,
    );
  }

  private streamingParameters(
    input: StreamTranscriptionRequest,
  ): Array<[string, string | number | boolean]> {
    const entries: Array<[string, string | number | boolean | string[] | undefined]> = [
      ['language-code', input.languageCode],
      ['identify-language', input.identifyLanguage],
      ['identify-multiple-languages', input.identifyMultipleLanguages],
      ['language-options', input.languageOptions],
      ['media-encoding', input.mediaEncoding],
      ['sample-rate', input.sampleRateHertz],
      ['session-id', input.sessionId],
      ['vocabulary-name', input.vocabularyName],
      ['vocabulary-names', input.vocabularyNames],
      ['vocabulary-filter-name', input.vocabularyFilterName],
      ['vocabulary-filter-names', input.vocabularyFilterNames],
      ['enable-channel-identification', input.enableChannelIdentification],
      ['number-of-channels', input.numberOfChannels],
      ['enable-partial-results-stabilization', input.enablePartialResultsStabilization],
      ['partial-results-stability', input.partialResultsStability],
      ['content-identification-type', input.contentIdentificationType],
      ['content-redaction-type', input.contentRedactionType],
      ['pii-entity-types', input.piiEntityTypes],
    ];
    return entries
      .filter((entry) => entry[1] !== undefined)
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(',') : (value as string | number | boolean),
      ]);
  }

  private pollySynthesisBody(input: SynthesizeSpeechRequest | StartSpeechSynthesisTaskRequest) {
    return compact({
      Engine: input.engine,
      LanguageCode: input.languageCode,
      LexiconNames: input.lexiconNames,
      OutputFormat: input.outputFormat,
      SampleRate: input.sampleRate,
      SpeechMarkTypes: input.speechMarkTypes,
      Text: input.text,
      TextType: input.textType,
      VoiceId: input.voiceId,
    });
  }

  private async sendTranscribeJson<T extends z.ZodTypeAny>(
    operation: string,
    body: Record<string, unknown>,
    schema: T,
  ): Promise<z.infer<T>>;
  private async sendTranscribeJson(
    operation: string,
    body: Record<string, unknown>,
    schema: undefined,
  ): Promise<void>;
  private async sendTranscribeJson<T extends z.ZodTypeAny>(
    operation: string,
    body: Record<string, unknown>,
    schema: T | undefined,
  ): Promise<z.infer<T> | void> {
    const response = await this.sendHttp('transcribe', operation, {
      method: 'POST',
      url: this.endpoints.transcribeBatch,
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `com.amazonaws.transcribe.Transcribe.${operation}`,
      },
      body: jsonBytes(body),
    });
    if (!schema) return;
    return this.parseJsonResponse(response, schema, 'transcribe', operation);
  }

  private async sendPollyJson<T extends z.ZodTypeAny>(
    operation: string,
    request: UnsignedAwsHttpRequest,
    schema: T,
  ): Promise<z.infer<T>> {
    const response = await this.sendHttp('polly', operation, request);
    return this.parseJsonResponse(response, schema, 'polly', operation);
  }

  private async sendHttp(
    service: AwsSpeechService,
    operation: string,
    request: UnsignedAwsHttpRequest,
  ): Promise<AwsHttpResponse> {
    const signed = await this.options.signer.signHttp(request, {
      region: this.options.region,
      service,
    });
    const response = await this.options.httpTransport.send(signed);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw parseAwsHttpError(service, operation, response);
    }
    return response;
  }

  private parseJsonResponse<T extends z.ZodTypeAny>(
    response: AwsHttpResponse,
    schema: T,
    service: AwsSpeechService,
    operation: string,
  ): z.infer<T> {
    try {
      return schema.parse(JSON.parse(decoder.decode(response.body)));
    } catch (error) {
      if (error instanceof AwsSpeechServiceError) throw error;
      throw new AwsSpeechServiceError(
        service,
        operation,
        'InvalidAwsResponse',
        `AWS ${service} returned an invalid ${operation} response`,
        response.statusCode,
        lowerHeader(response.headers, 'x-amzn-requestid'),
        false,
      );
    }
  }
}

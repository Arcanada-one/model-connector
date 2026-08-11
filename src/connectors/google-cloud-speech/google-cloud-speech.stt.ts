import { assertSuccessfulResponse } from './google-cloud-speech.errors';
import { speechV1Endpoint, speechV2Endpoint } from './google-cloud-speech.endpoints';
import {
  googleLongRunningOperationSchema,
  recognizeResponseSchema,
} from './google-cloud-speech.schemas';
import type {
  GoogleSpeechHttpTransport,
  GoogleSpeechStreamingTransport,
} from './google-cloud-speech.transport';
import type {
  GoogleAuthHeadersProvider,
  GoogleLongRunningOperation,
  JsonObject,
  RecognizeResponse,
  V1RecognizeInput,
  V1StreamingRecognizeRequest,
  V1StreamingRecognizeResponse,
  V2BatchRecognizeInput,
  V2RecognizeInput,
  V2StreamingRecognizeRequest,
  V2StreamingRecognizeResponse,
} from './google-cloud-speech.types';
import {
  V1_STREAMING_AUDIO_LIMIT_BYTES,
  V2_STREAMING_AUDIO_LIMIT_BYTES,
  assertRecognitionAudio,
  assertRecognitionOutputConfig,
  assertRequiredDuration,
  assertResourceLocation,
  assertValidBase64,
} from './google-cloud-speech.validation';

interface SpeechToTextClientOptions {
  auth: GoogleAuthHeadersProvider;
  httpTransport: GoogleSpeechHttpTransport;
  streamingTransport: GoogleSpeechStreamingTransport;
  location: string;
}

export class GoogleCloudSpeechToTextClient {
  private readonly auth: GoogleAuthHeadersProvider;
  private readonly httpTransport: GoogleSpeechHttpTransport;
  private readonly streamingTransport: GoogleSpeechStreamingTransport;
  private readonly location: string;

  constructor(options: SpeechToTextClientOptions) {
    this.auth = options.auth;
    this.httpTransport = options.httpTransport;
    this.streamingTransport = options.streamingTransport;
    this.location = options.location;
  }

  async recognizeV1(input: V1RecognizeInput): Promise<RecognizeResponse> {
    assertRecognitionAudio(input.audio);
    assertRequiredDuration(input.audioDurationSeconds, 60, 'V1 synchronous audio');
    const body = await this.post(speechV1Endpoint(this.location), '/v1/speech:recognize', {
      config: input.config,
      audio: input.audio,
    });
    return recognizeResponseSchema.parse(body) as RecognizeResponse;
  }

  async longRunningRecognizeV1(input: V1RecognizeInput): Promise<GoogleLongRunningOperation> {
    const audioKind = assertRecognitionAudio(input.audio);
    assertRequiredDuration(input.audioDurationSeconds, 28_800, 'V1 asynchronous audio');
    if (input.audioDurationSeconds > 60 && audioKind !== 'uri') {
      throw new Error('V1 asynchronous audio longer than 60 seconds requires a gs:// URI');
    }
    const body = await this.post(
      speechV1Endpoint(this.location),
      '/v1/speech:longrunningrecognize',
      { config: input.config, audio: input.audio },
    );
    return googleLongRunningOperationSchema.parse(body) as GoogleLongRunningOperation;
  }

  streamingRecognizeV1(
    requests: AsyncIterable<V1StreamingRecognizeRequest>,
    audioDurationSeconds: number,
  ): AsyncIterable<V1StreamingRecognizeResponse> {
    return this.invokeStream(
      speechV1Endpoint(this.location),
      'google.cloud.speech.v1.Speech',
      validateV1Frames(requests, audioDurationSeconds),
    );
  }

  async recognizeV2(input: V2RecognizeInput): Promise<RecognizeResponse> {
    assertResourceLocation(input.recognizer, this.location, 'recognizer');
    const audioKind = assertRecognitionAudio(input.audio);
    assertRequiredDuration(input.audioDurationSeconds, 60, 'V2 synchronous audio');
    const requestBody: JsonObject = { [audioKind]: input.audio[audioKind] };
    addOptional(requestBody, 'config', input.config);
    addOptional(requestBody, 'configMask', input.configMask);
    const body = await this.post(
      speechV2Endpoint(this.location),
      `/v2/${input.recognizer}:recognize`,
      requestBody,
    );
    return recognizeResponseSchema.parse(body) as RecognizeResponse;
  }

  async batchRecognizeV2(input: V2BatchRecognizeInput): Promise<GoogleLongRunningOperation> {
    assertResourceLocation(input.recognizer, this.location, 'recognizer');
    if (input.files.length === 0 || input.files.length > 5) {
      throw new Error('V2 batch recognition accepts a maximum of 5 files');
    }
    for (const file of input.files) {
      assertRecognitionAudio({ uri: file.uri });
      assertRequiredDuration(file.audioDurationSeconds, 28_800, 'V2 batch recognition file');
    }
    assertRecognitionOutputConfig(input.recognitionOutputConfig, input.files.length);
    const requestBody: JsonObject = {
      files: input.files.map(({ uri }) => ({ uri })),
      recognitionOutputConfig: input.recognitionOutputConfig,
    };
    addOptional(requestBody, 'config', input.config);
    addOptional(requestBody, 'configMask', input.configMask);
    addOptional(requestBody, 'processingStrategy', input.processingStrategy);
    const body = await this.post(
      speechV2Endpoint(this.location),
      `/v2/${input.recognizer}:batchRecognize`,
      requestBody,
    );
    return googleLongRunningOperationSchema.parse(body) as GoogleLongRunningOperation;
  }

  streamingRecognizeV2(
    requests: AsyncIterable<V2StreamingRecognizeRequest>,
  ): AsyncIterable<V2StreamingRecognizeResponse> {
    return this.invokeStream(
      speechV2Endpoint(this.location),
      'google.cloud.speech.v2.Speech',
      validateV2Frames(requests, this.location),
    );
  }

  private async post(endpoint: string, path: string, body: JsonObject): Promise<unknown> {
    const response = await this.httpTransport.request({
      method: 'POST',
      url: `https://${endpoint}${path}`,
      headers: {
        ...(await this.auth.getRequestHeaders()),
        'content-type': 'application/json',
      },
      body,
    });
    return assertSuccessfulResponse(response);
  }

  private async *invokeStream<T extends JsonObject>(
    endpoint: string,
    service: string,
    requests: AsyncIterable<unknown>,
  ): AsyncIterable<T> {
    const responses = this.streamingTransport.stream({
      endpoint,
      service,
      method: 'StreamingRecognize',
      metadata: await this.auth.getRequestHeaders(),
      requests,
    });
    for await (const response of responses) {
      yield recognizeResponseSchema.parse(response) as T;
    }
  }
}

async function* validateV1Frames(
  requests: AsyncIterable<V1StreamingRecognizeRequest>,
  audioDurationSeconds: number,
): AsyncIterable<V1StreamingRecognizeRequest> {
  assertRequiredDuration(audioDurationSeconds, 300, 'V1 streaming audio');
  let index = 0;
  for await (const request of requests) {
    if (index === 0) {
      if (request.streamingConfig === undefined || request.audioContent !== undefined) {
        throw new Error('V1 streaming first frame must contain configuration only');
      }
    } else {
      if (request.streamingConfig !== undefined || request.audioContent === undefined) {
        throw new Error('V1 streaming subsequent frames must contain audioContent only');
      }
      assertAudioFrame(request.audioContent, V1_STREAMING_AUDIO_LIMIT_BYTES, '25 KB');
    }
    index += 1;
    yield request;
  }
  if (index === 0) {
    throw new Error('V1 streaming first frame must contain configuration');
  }
}

async function* validateV2Frames(
  requests: AsyncIterable<V2StreamingRecognizeRequest>,
  location: string,
): AsyncIterable<V2StreamingRecognizeRequest> {
  let index = 0;
  for await (const request of requests) {
    if (index === 0) {
      if (request.audio !== undefined) {
        if (request.recognizer !== undefined || request.streamingConfig !== undefined) {
          throw new Error('V2 preconfigured-recognizer streaming frames must contain audio only');
        }
        assertAudioFrame(request.audio, V2_STREAMING_AUDIO_LIMIT_BYTES, '15 KB');
      } else {
        if (request.recognizer === undefined || request.streamingConfig === undefined) {
          throw new Error(
            'V2 streaming first frame must contain recognizer and configuration only',
          );
        }
        assertResourceLocation(request.recognizer, location, 'recognizer');
      }
    } else {
      if (
        request.recognizer !== undefined ||
        request.streamingConfig !== undefined ||
        request.audio === undefined
      ) {
        throw new Error('V2 streaming subsequent frames must contain audio only');
      }
      assertAudioFrame(request.audio, V2_STREAMING_AUDIO_LIMIT_BYTES, '15 KB');
    }
    index += 1;
    yield request;
  }
  if (index === 0) {
    throw new Error('V2 streaming first frame must contain configuration');
  }
}

function assertAudioFrame(content: string, maximumBytes: number, label: string): void {
  const bytes = assertValidBase64(content, 'streaming audio');
  if (bytes > maximumBytes) {
    throw new Error(`Streaming audio exceeds the ${label} per-message limit`);
  }
}

function addOptional(target: JsonObject, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

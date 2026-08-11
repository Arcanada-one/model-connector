import { assertSuccessfulResponse } from './google-cloud-speech.errors';
import { textToSpeechEndpoint } from './google-cloud-speech.endpoints';
import {
  googleLongRunningOperationSchema,
  listVoicesResponseSchema,
  streamingSynthesizeResponseSchema,
  synthesizeSpeechResponseSchema,
} from './google-cloud-speech.schemas';
import type {
  GoogleSpeechHttpTransport,
  GoogleSpeechStreamingTransport,
} from './google-cloud-speech.transport';
import type {
  GoogleAuthHeadersProvider,
  GoogleLongRunningOperation,
  ListVoicesResponse,
  StreamingSynthesizeRequest,
  StreamingSynthesizeResponse,
  SynthesizeLongAudioInput,
  SynthesizeSpeechResponse,
  SynthesizeV1Input,
} from './google-cloud-speech.types';
import {
  assertGcsUri,
  assertResourceLocation,
  assertStreamingEncoding,
  assertSynthesisInput,
  assertUnaryEncoding,
} from './google-cloud-speech.validation';

interface TextToSpeechClientOptions {
  auth: GoogleAuthHeadersProvider;
  httpTransport: GoogleSpeechHttpTransport;
  streamingTransport: GoogleSpeechStreamingTransport;
  location: string;
}

export class GoogleCloudTextToSpeechClient {
  private readonly auth: GoogleAuthHeadersProvider;
  private readonly httpTransport: GoogleSpeechHttpTransport;
  private readonly streamingTransport: GoogleSpeechStreamingTransport;
  private readonly location: string;

  constructor(options: TextToSpeechClientOptions) {
    this.auth = options.auth;
    this.httpTransport = options.httpTransport;
    this.streamingTransport = options.streamingTransport;
    this.location = options.location;
  }

  async synthesizeV1(input: SynthesizeV1Input): Promise<SynthesizeSpeechResponse> {
    assertSynthesisInput(input.input, 5_000);
    assertUnaryEncoding(input.audioConfig.audioEncoding);
    const body = await this.request({
      method: 'POST',
      path: '/v1/text:synthesize',
      body: input,
    });
    return synthesizeSpeechResponseSchema.parse(body) as SynthesizeSpeechResponse;
  }

  async listVoicesV1(languageCode?: string): Promise<ListVoicesResponse> {
    const query =
      languageCode === undefined ? '' : `?languageCode=${encodeURIComponent(languageCode)}`;
    const body = await this.request({ method: 'GET', path: `/v1/voices${query}` });
    return listVoicesResponseSchema.parse(body) as ListVoicesResponse;
  }

  async synthesizeLongAudio(input: SynthesizeLongAudioInput): Promise<GoogleLongRunningOperation> {
    assertResourceLocation(input.parent, this.location, 'parent');
    assertSynthesisInput(input.input, 1_000_000);
    assertUnaryEncoding(input.audioConfig.audioEncoding);
    assertGcsUri(input.outputGcsUri, 'outputGcsUri');
    const version = input.version ?? 'v1';
    const body = await this.request({
      method: 'POST',
      path: `/${version}/${input.parent}:synthesizeLongAudio`,
      body: {
        input: input.input,
        voice: input.voice,
        audioConfig: input.audioConfig,
        outputGcsUri: input.outputGcsUri,
      },
    });
    return googleLongRunningOperationSchema.parse(body) as GoogleLongRunningOperation;
  }

  streamingSynthesizeV1(
    requests: AsyncIterable<StreamingSynthesizeRequest>,
  ): AsyncIterable<StreamingSynthesizeResponse> {
    return this.invokeStreamingSynthesis(validateStreamingFrames(requests));
  }

  private async request(input: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
  }): Promise<unknown> {
    const headers = await this.auth.getRequestHeaders();
    if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await this.httpTransport.request({
      method: input.method,
      url: `https://${textToSpeechEndpoint(this.location)}${input.path}`,
      headers,
      body: input.body,
    });
    return assertSuccessfulResponse(response);
  }

  private async *invokeStreamingSynthesis(
    requests: AsyncIterable<StreamingSynthesizeRequest>,
  ): AsyncIterable<StreamingSynthesizeResponse> {
    const responses = this.streamingTransport.stream({
      endpoint: textToSpeechEndpoint(this.location),
      service: 'google.cloud.texttospeech.v1.TextToSpeech',
      method: 'StreamingSynthesize',
      metadata: await this.auth.getRequestHeaders(),
      requests,
    });
    for await (const response of responses) {
      yield streamingSynthesizeResponseSchema.parse(response) as StreamingSynthesizeResponse;
    }
  }
}

async function* validateStreamingFrames(
  requests: AsyncIterable<StreamingSynthesizeRequest>,
): AsyncIterable<StreamingSynthesizeRequest> {
  let index = 0;
  for await (const request of requests) {
    if (index === 0) {
      validateStreamingConfiguration(request);
    } else {
      validateStreamingInput(request);
    }
    index += 1;
    yield request;
  }
  if (index === 0) {
    throw new Error('Streaming synthesis first frame must contain configuration');
  }
}

function validateStreamingConfiguration(request: StreamingSynthesizeRequest): void {
  if (request.streamingConfig === undefined || request.input !== undefined) {
    throw new Error('Streaming synthesis first frame must contain configuration only');
  }
  const { voice, streamingAudioConfig } = request.streamingConfig;
  if (voice.name === undefined || !/-Chirp3-HD-/i.test(voice.name)) {
    throw new Error('Streaming synthesis Preview requires a Chirp 3 HD voice');
  }
  assertStreamingEncoding(streamingAudioConfig.audioEncoding);
}

function validateStreamingInput(request: StreamingSynthesizeRequest): void {
  if (request.streamingConfig !== undefined || request.input === undefined) {
    throw new Error('Streaming synthesis subsequent frames must contain input only');
  }
  assertSynthesisInput(request.input, Number.MAX_SAFE_INTEGER);
}

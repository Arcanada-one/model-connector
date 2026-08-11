import {
  assertAzureSpeechAuthenticationSupported,
  azureSpeechRestAuthenticationHeaders,
} from './auth';
import { AZURE_SPEECH_CAPABILITIES } from './capabilities';
import { AzureSpeechError, errorFromProviderPayload, localAzureSpeechError } from './errors';
import { azureSpeechAuthorities } from './endpoint';
import type {
  AzureSpeechBatchPollingOptions,
  AzureSpeechBatchSubmitResult,
  AzureSpeechBatchTranscriptionInput,
  AzureSpeechConnectorOptions,
  AzureSpeechDelay,
  AzureSpeechFastTranscriptionInput,
  AzureSpeechStreamingAudioContentType,
  AzureSpeechStreamingTranscriptionInput,
  AzureSpeechSynthesisInput,
  AzureSpeechSynthesisResult,
  AzureSpeechVoice,
} from './types';

const SPEECH_TO_TEXT_API_VERSION = '2025-10-15';
const MINIMUM_POLLING_INTERVAL_MS = 60_000;
const STREAMING_AUDIO_CONTENT_TYPES = new Set<string>(
  AZURE_SPEECH_CAPABILITIES.streaming.supportedAudioContentTypes,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonempty(value: string, field: string): string {
  if (value.trim() === '') {
    throw localAzureSpeechError('InvalidInput', `${field} must be nonempty.`);
  }
  return value;
}

async function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw localAzureSpeechError('Aborted', 'The operation was aborted.');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(localAzureSpeechError('Aborted', 'The operation was aborted.'));
    };

    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function readResponsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const text = await response.text();
  if (text === '') {
    return '';
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return text;
}

function assertExpectedStatus(response: Response, expectedStatus: number, payload: unknown): void {
  if (!response.ok) {
    throw errorFromProviderPayload(response.status, payload);
  }
  if (response.status !== expectedStatus) {
    throw new AzureSpeechError({
      statusCode: response.status,
      code: 'InvalidProviderResponse',
      message: `Azure Speech returned HTTP ${response.status}; expected ${expectedStatus}.`,
      payload,
    });
  }
}

function assertJsonRecord(payload: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new AzureSpeechError({
      statusCode: 200,
      code: 'InvalidProviderResponse',
      message: `${operation} returned a non-object response.`,
      payload,
    });
  }
  return payload;
}

function transcriptionStatus(
  transcription: Record<string, unknown>,
): 'NotStarted' | 'Running' | 'Succeeded' | 'Failed' {
  const status = transcription.status;
  if (
    status !== 'NotStarted' &&
    status !== 'Running' &&
    status !== 'Succeeded' &&
    status !== 'Failed'
  ) {
    throw new AzureSpeechError({
      statusCode: 200,
      code: 'InvalidProviderResponse',
      message: 'Batch transcription returned an unknown status.',
      payload: transcription,
    });
  }
  return status;
}

function validateBatchInput(input: AzureSpeechBatchTranscriptionInput): void {
  requireNonempty(input.displayName, 'displayName');
  requireNonempty(input.locale, 'locale');
  if (!isRecord(input.properties)) {
    throw localAzureSpeechError('InvalidBatchInput', 'properties must be an object.');
  }

  const hasUrls = Array.isArray(input.contentUrls) && input.contentUrls.length > 0;
  const hasContainer =
    typeof input.contentContainerUrl === 'string' && input.contentContainerUrl.trim() !== '';
  if (hasUrls === hasContainer) {
    throw localAzureSpeechError(
      'InvalidBatchInput',
      'Provide exactly one of contentUrls or contentContainerUrl.',
    );
  }

  if (
    input.contentUrls !== undefined &&
    (input.contentUrls.length === 0 || input.contentUrls.length > 1_000)
  ) {
    throw localAzureSpeechError(
      'InvalidBatchInput',
      'contentUrls must contain between 1 and 1,000 URLs.',
    );
  }

  const ttl = input.properties.timeToLiveHours;
  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 6 || ttl > 31 * 24)) {
    throw localAzureSpeechError(
      'InvalidBatchInput',
      'timeToLiveHours must be an integer from 6 through 744.',
    );
  }
}

export function validateFastTranscriptionLimits(
  byteLength: number,
  durationSeconds?: number,
): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength >= AZURE_SPEECH_CAPABILITIES.fast.maxBytesExclusive
  ) {
    throw localAzureSpeechError(
      'FastTranscriptionLimitExceeded',
      'Fast transcription audio must be smaller than 250 MB.',
    );
  }

  if (
    durationSeconds !== undefined &&
    (!Number.isFinite(durationSeconds) ||
      durationSeconds < 0 ||
      durationSeconds >= AZURE_SPEECH_CAPABILITIES.fast.maxDurationSecondsExclusive)
  ) {
    throw localAzureSpeechError(
      'FastTranscriptionLimitExceeded',
      'Fast transcription audio must be shorter than two hours.',
    );
  }
}

export class AzureSpeechConnector {
  private readonly options: AzureSpeechConnectorOptions;
  private readonly delay: AzureSpeechDelay;

  constructor(options: AzureSpeechConnectorOptions) {
    azureSpeechAuthorities(options.deployment);
    this.options = options;
    this.delay = options.delay ?? defaultDelay;
  }

  async fastTranscribe(input: AzureSpeechFastTranscriptionInput): Promise<Record<string, unknown>> {
    validateFastTranscriptionLimits(input.audio.byteLength, input.durationSeconds);
    requireNonempty(input.filename, 'filename');
    requireNonempty(input.mimeType, 'mimeType');
    assertAzureSpeechAuthenticationSupported(
      this.options.authentication,
      this.options.deployment,
      'fast-or-batch',
    );

    const form = new FormData();
    const audio = new Uint8Array(input.audio.byteLength);
    audio.set(input.audio);
    form.append('audio', new Blob([audio], { type: input.mimeType }), input.filename);
    form.append('definition', JSON.stringify(input.definition));

    const response = await this.options.httpTransport(
      `${this.managementUrl()}/speechtotext/transcriptions:transcribe?api-version=${SPEECH_TO_TEXT_API_VERSION}`,
      {
        method: 'POST',
        headers: this.restHeaders('fast-or-batch'),
        body: form,
        signal: input.signal,
      },
    );
    const payload = await readResponsePayload(response);
    assertExpectedStatus(response, 200, payload);
    return assertJsonRecord(payload, 'Fast transcription');
  }

  async submitBatchTranscription(
    input: AzureSpeechBatchTranscriptionInput,
  ): Promise<AzureSpeechBatchSubmitResult> {
    validateBatchInput(input);
    const { signal, contentUrls, contentContainerUrl, ...requestFields } = input;
    const body = {
      ...requestFields,
      ...(contentUrls === undefined ? {} : { contentUrls }),
      ...(contentContainerUrl === undefined ? {} : { contentContainerUrl }),
    };

    const response = await this.options.httpTransport(
      `${this.managementUrl()}/speechtotext/transcriptions:submit?api-version=${SPEECH_TO_TEXT_API_VERSION}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.restHeaders('fast-or-batch'),
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    const payload = await readResponsePayload(response);
    assertExpectedStatus(response, 201, payload);
    const location = response.headers.get('location');
    if (!location) {
      throw new AzureSpeechError({
        statusCode: response.status,
        code: 'InvalidProviderResponse',
        message: 'Batch submission returned no Location header.',
        payload,
      });
    }

    return {
      transcription: assertJsonRecord(payload, 'Batch submission'),
      location,
    };
  }

  async getBatchTranscription(
    transcriptionId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.options.httpTransport(this.batchResourceUrl(transcriptionId), {
      method: 'GET',
      headers: this.restHeaders('fast-or-batch'),
      signal,
    });
    const payload = await readResponsePayload(response);
    assertExpectedStatus(response, 200, payload);
    const transcription = assertJsonRecord(payload, 'Batch status');
    transcriptionStatus(transcription);
    return transcription;
  }

  async listBatchTranscriptionFiles(
    transcriptionId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const transcription = await this.getBatchTranscription(transcriptionId, signal);
    if (transcriptionStatus(transcription) !== 'Succeeded') {
      throw new AzureSpeechError({
        statusCode: 200,
        code: 'BatchNotSucceeded',
        message: 'Batch files are available only after Succeeded.',
        payload: transcription,
      });
    }

    const response = await this.options.httpTransport(
      `${this.batchResourceUrl(transcriptionId, false)}/files?api-version=${SPEECH_TO_TEXT_API_VERSION}`,
      {
        method: 'GET',
        headers: this.restHeaders('fast-or-batch'),
        signal,
      },
    );
    const payload = await readResponsePayload(response);
    assertExpectedStatus(response, 200, payload);
    return assertJsonRecord(payload, 'Batch files');
  }

  async deleteBatchTranscription(transcriptionId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.options.httpTransport(this.batchResourceUrl(transcriptionId), {
      method: 'DELETE',
      headers: this.restHeaders('fast-or-batch'),
      signal,
    });
    const payload = await readResponsePayload(response);
    assertExpectedStatus(response, 204, payload);
  }

  async pollBatchTranscription(
    transcriptionId: string,
    options: AzureSpeechBatchPollingOptions,
  ): Promise<Record<string, unknown>> {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw localAzureSpeechError(
        'InvalidPollingOptions',
        'maxAttempts must be a positive integer.',
      );
    }
    const intervalMs = options.intervalMs ?? MINIMUM_POLLING_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs < MINIMUM_POLLING_INTERVAL_MS) {
      throw localAzureSpeechError('InvalidPollingOptions', 'intervalMs must be at least 60,000.');
    }

    for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
      this.throwIfAborted(options.signal);
      const transcription = await this.getBatchTranscription(transcriptionId, options.signal);
      const status = transcriptionStatus(transcription);
      if (status === 'Succeeded') {
        return transcription;
      }
      if (status === 'Failed') {
        throw errorFromProviderPayload(200, transcription);
      }
      if (attempt + 1 < options.maxAttempts) {
        if (options.signal) {
          await this.delay(intervalMs, options.signal);
        } else {
          await this.delay(intervalMs);
        }
      }
    }

    throw localAzureSpeechError(
      'PollingLimitExceeded',
      'Batch transcription did not reach a terminal state within maxAttempts.',
    );
  }

  streamTranscription(input: AzureSpeechStreamingTranscriptionInput) {
    assertAzureSpeechAuthenticationSupported(
      this.options.authentication,
      this.options.deployment,
      'streaming',
    );
    requireNonempty(input.locale, 'locale');
    if (!STREAMING_AUDIO_CONTENT_TYPES.has(input.contentType)) {
      throw localAzureSpeechError(
        'UnsupportedStreamingAudioFormat',
        'Streaming supports only documented 16 kHz mono WAV/PCM or OGG/Opus content types.',
      );
    }
    if (
      input.timeoutMs !== undefined &&
      (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)
    ) {
      throw localAzureSpeechError(
        'InvalidStreamingInput',
        'timeoutMs must be positive when provided.',
      );
    }
    if (input.customEndpointId !== undefined && input.customEndpointId.trim() === '') {
      throw localAzureSpeechError(
        'InvalidStreamingInput',
        'customEndpointId must be nonempty when provided.',
      );
    }

    const query = new URLSearchParams({
      language: input.locale,
      format: input.outputFormat,
    });
    if (input.customEndpointId) {
      query.set('cid', input.customEndpointId);
    }
    const authorities = azureSpeechAuthorities(this.options.deployment);
    const resourcePrefix = authorities.resourceEndpoint ? '/stt' : '';
    const url =
      `${authorities.streaming}${resourcePrefix}` +
      '/speech/recognition/conversation/cognitiveservices/v1?' +
      query.toString();

    return this.options.streamingTransport.connect({
      url,
      authentication: this.options.authentication,
      contentType: input.contentType as AzureSpeechStreamingAudioContentType,
      audio: input.audio,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
  }

  async synthesizeSpeech(input: AzureSpeechSynthesisInput): Promise<AzureSpeechSynthesisResult> {
    requireNonempty(input.ssml, 'ssml');
    requireNonempty(input.outputFormat, 'outputFormat');
    if (input.userAgent.length === 0 || input.userAgent.length >= 255) {
      throw localAzureSpeechError(
        'InvalidSynthesisInput',
        'userAgent must contain between 1 and 254 characters.',
      );
    }

    const authorities = azureSpeechAuthorities(this.options.deployment);
    const resourcePrefix = authorities.resourceEndpoint ? '/tts' : '';
    const response = await this.options.httpTransport(
      `${authorities.textToSpeech}${resourcePrefix}/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ssml+xml',
          ...this.restHeaders('tts-or-voices'),
          'User-Agent': input.userAgent,
          'X-Microsoft-OutputFormat': input.outputFormat,
        },
        body: input.ssml,
        signal: input.signal,
      },
    );

    if (!response.ok) {
      const payload = await readResponsePayload(response);
      throw errorFromProviderPayload(response.status, payload);
    }
    if (response.status !== 200) {
      throw new AzureSpeechError({
        statusCode: response.status,
        code: 'InvalidProviderResponse',
        message: `Speech synthesis returned HTTP ${response.status}; expected 200.`,
      });
    }

    return {
      audio: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type'),
    };
  }

  async listVoices(signal?: AbortSignal): Promise<AzureSpeechVoice[]> {
    const authorities = azureSpeechAuthorities(this.options.deployment);
    const resourcePrefix = authorities.resourceEndpoint ? '/tts' : '';
    const response = await this.options.httpTransport(
      `${authorities.textToSpeech}${resourcePrefix}/cognitiveservices/voices/list`,
      {
        method: 'GET',
        headers: this.restHeaders('tts-or-voices'),
        signal,
      },
    );
    const payload = await readResponsePayload(response);
    assertExpectedStatus(response, 200, payload);
    if (!Array.isArray(payload) || !payload.every(isRecord)) {
      throw new AzureSpeechError({
        statusCode: response.status,
        code: 'InvalidProviderResponse',
        message: 'Voice discovery returned a non-array response.',
        payload,
      });
    }
    return payload;
  }

  private managementUrl(): string {
    return azureSpeechAuthorities(this.options.deployment).management;
  }

  private restHeaders(operation: 'fast-or-batch' | 'tts-or-voices'): Record<string, string> {
    return azureSpeechRestAuthenticationHeaders(
      this.options.authentication,
      this.options.deployment,
      operation,
    );
  }

  private batchResourceUrl(transcriptionId: string, includeApiVersion = true): string {
    const id = requireNonempty(transcriptionId, 'transcriptionId');
    const base = `${this.managementUrl()}/speechtotext/transcriptions/` + encodeURIComponent(id);
    return includeApiVersion ? `${base}?api-version=${SPEECH_TO_TEXT_API_VERSION}` : base;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw localAzureSpeechError('Aborted', 'The operation was aborted.');
    }
  }
}

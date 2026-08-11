import type {
  RecognitionAudio,
  RecognitionOutputConfig,
  SynthesisInput,
  UnaryAudioEncoding,
  StreamingAudioEncoding,
} from './google-cloud-speech.types';

const BASE64_CONTENT_PATTERN = /^[A-Za-z0-9+/_-]+$/;
const GCS_URI_PATTERN = /^gs:\/\/[^/\s]+\/\S+$/;
const LOCATION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const PROJECT_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}';
const LOCATION_SEGMENT = '[a-z][a-z0-9-]{0,62}';
const RESOURCE_ID_SEGMENT = '(?:_|[A-Za-z0-9][A-Za-z0-9._~-]{0,127})';
const RECOGNIZER_RESOURCE_PATTERN = new RegExp(
  `^projects/(${PROJECT_SEGMENT})/locations/(${LOCATION_SEGMENT})/recognizers/${RESOURCE_ID_SEGMENT}$`,
);
const PARENT_RESOURCE_PATTERN = new RegExp(
  `^projects/(${PROJECT_SEGMENT})/locations/(${LOCATION_SEGMENT})$`,
);

export const V1_STREAMING_AUDIO_LIMIT_BYTES = 25 * 1024;
export const V2_STREAMING_AUDIO_LIMIT_BYTES = 15 * 1024;
export const SYNC_AUDIO_LIMIT_BYTES = 10 * 1024 * 1024;

export function assertValidBase64(value: string, field: string): number {
  const content = value.replace(/=+$/, '');
  const paddingLength = value.length - content.length;
  const invalidLength = content.length % 4 === 1;
  const invalidPadding = paddingLength > 2 || (paddingLength > 0 && value.length % 4 !== 0);
  if (
    content.length === 0 ||
    !BASE64_CONTENT_PATTERN.test(content) ||
    invalidLength ||
    invalidPadding
  ) {
    throw new Error(`${field} must be non-empty base64`);
  }
  const normalized = content.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').byteLength;
}

export function assertGcsUri(value: string, field: string): void {
  if (!GCS_URI_PATTERN.test(value)) {
    throw new Error(`${field} must be a gs:// Cloud Storage URI`);
  }
}

export function assertRecognitionAudio(audio: RecognitionAudio): 'content' | 'uri' {
  const hasContent = typeof audio.content === 'string';
  const hasUri = typeof audio.uri === 'string';
  if (hasContent === hasUri) {
    throw new Error('Recognition audio must contain exactly one of content or uri');
  }
  if (hasContent) {
    const bytes = assertValidBase64(audio.content ?? '', 'audio.content');
    if (bytes > SYNC_AUDIO_LIMIT_BYTES) {
      throw new Error('Inline recognition audio exceeds the 10 MB limit');
    }
    return 'content';
  }
  assertGcsUri(audio.uri ?? '', 'audio.uri');
  return 'uri';
}

export function assertDuration(
  seconds: number | undefined,
  maximumSeconds: number,
  label: string,
): void {
  if (seconds === undefined) {
    return;
  }
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > maximumSeconds) {
    throw new Error(`${label} must not exceed ${maximumSeconds.toLocaleString('en-US')} seconds`);
  }
}

export function assertRequiredDuration(
  seconds: number | undefined,
  maximumSeconds: number,
  label: string,
): void {
  if (seconds === undefined) {
    throw new Error(`${label} duration is required`);
  }
  assertDuration(seconds, maximumSeconds, label);
}

export function assertRecognitionOutputConfig(
  config: RecognitionOutputConfig,
  fileCount: number,
): void {
  const hasGcsOutput = config.gcsOutputConfig !== undefined;
  const hasInlineOutput = config.inlineResponseConfig !== undefined;
  if (hasGcsOutput === hasInlineOutput) {
    throw new Error(
      'Recognition output must contain exactly one of gcsOutputConfig or inlineResponseConfig',
    );
  }
  if (hasGcsOutput) {
    assertGcsUri(config.gcsOutputConfig?.uri ?? '', 'gcsOutputConfig.uri');
  }
  if (hasInlineOutput && fileCount !== 1) {
    throw new Error('Inline recognition output supports exactly one file');
  }
}

export function assertLocation(location: string): void {
  if (location !== 'global' && !LOCATION_PATTERN.test(location)) {
    throw new Error(`Invalid Google Cloud location: ${location}`);
  }
}

export function locationFromResource(resource: string, kind: 'recognizer' | 'parent'): string {
  const pattern = kind === 'recognizer' ? RECOGNIZER_RESOURCE_PATTERN : PARENT_RESOURCE_PATTERN;
  const match = pattern.exec(resource);
  if (!match?.[2]) {
    throw new Error(`Invalid Google Cloud ${kind} resource: ${resource}`);
  }
  return match[2];
}

export function assertResourceLocation(
  resource: string,
  selectedLocation: string,
  kind: 'recognizer' | 'parent',
): void {
  const resourceLocation = locationFromResource(resource, kind);
  if (resourceLocation !== selectedLocation) {
    throw new Error(
      `${kind} location ${resourceLocation} does not match selected endpoint ${selectedLocation}`,
    );
  }
}

export function assertSynthesisInput(input: SynthesisInput, maximumBytes: number): void {
  const hasText = typeof input.text === 'string';
  const hasSsml = typeof input.ssml === 'string';
  if (hasText === hasSsml) {
    throw new Error('Synthesis input must contain exactly one of text or ssml');
  }
  const value = hasText ? (input.text ?? '') : (input.ssml ?? '');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) {
    throw new Error(`Synthesis input exceeds ${maximumBytes.toLocaleString('en-US')} bytes`);
  }
}

export function assertUnaryEncoding(encoding: string): asserts encoding is UnaryAudioEncoding {
  const allowed: UnaryAudioEncoding[] = ['LINEAR16', 'MP3', 'OGG_OPUS', 'MULAW', 'ALAW'];
  if (!allowed.includes(encoding as UnaryAudioEncoding)) {
    throw new Error(`Unary audioEncoding must be one of ${allowed.join(', ')}`);
  }
}

export function assertStreamingEncoding(
  encoding: string,
): asserts encoding is StreamingAudioEncoding {
  const allowed: StreamingAudioEncoding[] = ['PCM', 'ALAW', 'MULAW', 'OGG_OPUS'];
  if (!allowed.includes(encoding as StreamingAudioEncoding)) {
    throw new Error(`Streaming audioEncoding must be one of ${allowed.join(', ')}`);
  }
}

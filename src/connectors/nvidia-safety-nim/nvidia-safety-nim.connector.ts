export const NVIDIA_SAFETY_NIM_MODEL = 'nvidia/nemotron-3.5-content-safety' as const;
export const NVIDIA_SAFETY_NIM_CONTRACT_VERSION = 'nvidia-safety-nim/v1' as const;
export const NVIDIA_SAFETY_NIM_TRANSPORT_VERSION =
  'nvidia-safety-nim-transport/v1' as const;

export type NvidiaSafetyVerdict = 'safe' | 'unsafe';
export type NvidiaSafetyImageMediaType = 'image/gif' | 'image/jpeg' | 'image/png';
export type NvidiaSafetyNimErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'transport_timeout'
  | 'transport_failure'
  | 'provider_error'
  | 'invalid_response';

export interface NvidiaSafetyNimTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface NvidiaSafetyNimImageContent {
  readonly type: 'image_url';
  readonly image_url: Readonly<{ url: string }>;
}

export interface NvidiaSafetyNimMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly (NvidiaSafetyNimTextContent | NvidiaSafetyNimImageContent)[];
}

export interface NvidiaSafetyNimRequestBody {
  readonly model: typeof NVIDIA_SAFETY_NIM_MODEL;
  readonly messages: readonly NvidiaSafetyNimMessage[];
  readonly max_tokens: 100;
  readonly temperature: 0.01;
  readonly top_p: 0.95;
  readonly chat_template_kwargs: Readonly<{
    request_categories: '/categories' | '/no_categories';
    enable_thinking: false;
    custom_policy?: string;
  }>;
}

export interface NvidiaSafetyNimTransportRequest {
  readonly contractVersion: typeof NVIDIA_SAFETY_NIM_TRANSPORT_VERSION;
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<'Accept' | 'Content-Type', string>>;
  readonly body: NvidiaSafetyNimRequestBody;
  readonly timeoutMs: number;
}

export interface NvidiaSafetyNimTransport {
  readonly send: (request: NvidiaSafetyNimTransportRequest) => Promise<unknown>;
}

export interface NvidiaSafetyNimClassificationResult {
  readonly contractVersion: typeof NVIDIA_SAFETY_NIM_CONTRACT_VERSION;
  readonly model: typeof NVIDIA_SAFETY_NIM_MODEL;
  readonly userSafety: NvidiaSafetyVerdict;
  readonly responseSafety?: NvidiaSafetyVerdict;
  readonly safetyCategories?: string;
}

const ERROR_MESSAGES: Readonly<Record<NvidiaSafetyNimErrorCode, string>> = Object.freeze({
  invalid_configuration: 'NVIDIA Safety NIM configuration rejected',
  invalid_request: 'NVIDIA Safety NIM request rejected',
  transport_timeout: 'NVIDIA Safety NIM transport timed out',
  transport_failure: 'NVIDIA Safety NIM transport failed',
  provider_error: 'NVIDIA Safety NIM provider rejected the request',
  invalid_response: 'NVIDIA Safety NIM response was rejected',
});

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const IMAGE_MEDIA_TYPES = new Set<NvidiaSafetyImageMediaType>([
  'image/gif',
  'image/jpeg',
  'image/png',
]);
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'metadata.google.internal',
  '[fd00:ec2::254]',
  'fd00:ec2::254',
]);
const MAX_TEXT_CODE_UNITS = 16_384;
const MAX_TEXT_BYTES = 65_536;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_CODE_UNITS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_BODY_BYTES = 7_500_000;
const MAX_RESPONSE_CODE_UNITS = 4_096;
const MAX_RESPONSE_BYTES = 16_384;
const MAX_CATEGORY_CODE_UNITS = 512;
const MAX_CATEGORY_BYTES = 2_048;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

interface SafeValueLimits {
  readonly maxDepth: number;
  readonly maxWidth: number;
  readonly maxNodes: number;
  readonly maxStringCodeUnits: number;
  readonly maxStringBytes: number;
  readonly allowFunction: boolean;
}

interface InspectionState {
  nodes: number;
  readonly active: WeakSet<object>;
}

interface DataDescriptor extends PropertyDescriptor {
  readonly value: unknown;
}

class UnsafeValueError extends Error {}

export class NvidiaSafetyNimError extends Error {
  readonly code: NvidiaSafetyNimErrorCode;

  constructor(code: NvidiaSafetyNimErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'NvidiaSafetyNimError';
    this.code = code;
  }
}

const reject = (code: NvidiaSafetyNimErrorCode): never => {
  throw new NvidiaSafetyNimError(code);
};

const rejectUnsafe = (): never => {
  throw new UnsafeValueError();
};

const dataDescriptor = (value: object, key: PropertyKey): DataDescriptor => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    !descriptor ||
    !('value' in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !descriptor.enumerable
  ) {
    return rejectUnsafe();
  }
  return descriptor as DataDescriptor;
};

const inspectValue = (
  value: unknown,
  limits: SafeValueLimits,
  depth: number,
  state: InspectionState,
): unknown => {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes || depth > limits.maxDepth) return rejectUnsafe();

  if (typeof value === 'string') {
    if (
      value.length > limits.maxStringCodeUnits ||
      Buffer.byteLength(value, 'utf8') > limits.maxStringBytes
    ) {
      return rejectUnsafe();
    }
    return value;
  }
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return rejectUnsafe();
    return value;
  }
  if (typeof value === 'function' && limits.allowFunction) return value;
  if (typeof value !== 'object' || Array.isArray(value)) return rejectUnsafe();

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return rejectUnsafe();
  if (state.active.has(value)) return rejectUnsafe();
  state.active.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length > limits.maxWidth || keys.some((key) => typeof key === 'symbol')) {
      return rejectUnsafe();
    }
    const clone: Record<string, unknown> = {};
    for (const rawKey of keys) {
      const key = rawKey as string;
      if (DANGEROUS_KEYS.has(key)) return rejectUnsafe();
      const descriptor = dataDescriptor(value, key);
      clone[key] = inspectValue(descriptor.value, limits, depth + 1, state);
    }
    return clone;
  } finally {
    state.active.delete(value);
  }
};

const inspectAndClone = (value: unknown, limits: SafeValueLimits): unknown =>
  inspectValue(value, limits, 0, { nodes: 0, active: new WeakSet<object>() });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

const hasRequiredOptionalKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
};

const CONFIG_LIMITS: SafeValueLimits = Object.freeze({
  maxDepth: 2,
  maxWidth: 8,
  maxNodes: 16,
  maxStringCodeUnits: 2_048,
  maxStringBytes: 4_096,
  allowFunction: false,
});

const TRANSPORT_LIMITS: SafeValueLimits = Object.freeze({
  maxDepth: 1,
  maxWidth: 1,
  maxNodes: 2,
  maxStringCodeUnits: 0,
  maxStringBytes: 0,
  allowFunction: true,
});

const REQUEST_LIMITS: SafeValueLimits = Object.freeze({
  maxDepth: 8,
  maxWidth: 16,
  maxNodes: 64,
  maxStringCodeUnits: MAX_BASE64_CODE_UNITS,
  maxStringBytes: MAX_BASE64_CODE_UNITS,
  allowFunction: false,
});

const RESPONSE_LIMITS: SafeValueLimits = Object.freeze({
  maxDepth: 2,
  maxWidth: 4,
  maxNodes: 8,
  maxStringCodeUnits: MAX_RESPONSE_CODE_UNITS,
  maxStringBytes: MAX_RESPONSE_BYTES,
  allowFunction: false,
});

interface NormalizedConfiguration {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

interface NormalizedImage {
  readonly mediaType: NvidiaSafetyImageMediaType;
  readonly base64: string;
}

interface NormalizedClassificationRequest {
  readonly prompt: string;
  readonly includeCategories: boolean;
  readonly response?: string;
  readonly image?: NormalizedImage;
  readonly customPolicy?: string;
}

const validateText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_TEXT_CODE_UNITS &&
  Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES;

const normalizeBaseUrl = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    return reject('invalid_configuration');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return reject('invalid_configuration');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return reject('invalid_configuration');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === '0.0.0.0' ||
    hostname === '[::]' ||
    hostname === '::' ||
    METADATA_HOSTS.has(hostname) ||
    hostname.startsWith('169.254.') ||
    hostname.startsWith('[fe80:') ||
    hostname.startsWith('fe80:')
  ) {
    return reject('invalid_configuration');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
};

const normalizeConfiguration = (input: unknown): NormalizedConfiguration => {
  try {
    const cloned = inspectAndClone(input, CONFIG_LIMITS);
    if (
      !isRecord(cloned) ||
      !hasExactKeys(cloned, [
        'contractVersion',
        'deployment',
        'baseUrl',
        'model',
        'timeoutMs',
      ]) ||
      cloned.contractVersion !== NVIDIA_SAFETY_NIM_CONTRACT_VERSION ||
      cloned.deployment !== 'caller-operated-nim' ||
      cloned.model !== NVIDIA_SAFETY_NIM_MODEL ||
      !Number.isInteger(cloned.timeoutMs) ||
      (cloned.timeoutMs as number) < 1 ||
      (cloned.timeoutMs as number) > 30_000
    ) {
      return reject('invalid_configuration');
    }
    return {
      baseUrl: normalizeBaseUrl(cloned.baseUrl),
      timeoutMs: cloned.timeoutMs as number,
    };
  } catch (error: unknown) {
    if (error instanceof NvidiaSafetyNimError) throw error;
    return reject('invalid_configuration');
  }
};

const normalizeTransport = (input: unknown): NvidiaSafetyNimTransport['send'] => {
  try {
    const cloned = inspectAndClone(input, TRANSPORT_LIMITS);
    if (!isRecord(cloned) || !hasExactKeys(cloned, ['send']) || typeof cloned.send !== 'function') {
      return reject('invalid_configuration');
    }
    return cloned.send as NvidiaSafetyNimTransport['send'];
  } catch (error: unknown) {
    if (error instanceof NvidiaSafetyNimError) throw error;
    return reject('invalid_configuration');
  }
};

const isBase64Character = (code: number): boolean =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 43 ||
  code === 47;

const isCanonicalBase64 = (value: string): boolean => {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const dataEnd = value.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    if (!isBase64Character(value.charCodeAt(index))) return false;
  }
  for (let index = dataEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
};

const normalizeImage = (value: unknown): NormalizedImage => {
  if (!isRecord(value) || !hasExactKeys(value, ['mediaType', 'base64'])) {
    return reject('invalid_request');
  }
  const mediaType = value.mediaType;
  const base64 = value.base64;
  if (
    typeof mediaType !== 'string' ||
    !IMAGE_MEDIA_TYPES.has(mediaType as NvidiaSafetyImageMediaType) ||
    typeof base64 !== 'string' ||
    base64.length > MAX_BASE64_CODE_UNITS ||
    !isCanonicalBase64(base64)
  ) {
    return reject('invalid_request');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== base64) {
    return reject('invalid_request');
  }
  return { mediaType: mediaType as NvidiaSafetyImageMediaType, base64 };
};

const normalizeRequest = (input: unknown): NormalizedClassificationRequest => {
  try {
    const cloned = inspectAndClone(input, REQUEST_LIMITS);
    if (
      !isRecord(cloned) ||
      !hasRequiredOptionalKeys(
        cloned,
        ['prompt', 'includeCategories'],
        ['response', 'image', 'customPolicy'],
      ) ||
      !validateText(cloned.prompt) ||
      typeof cloned.includeCategories !== 'boolean' ||
      (Object.hasOwn(cloned, 'response') && !validateText(cloned.response)) ||
      (Object.hasOwn(cloned, 'customPolicy') && !validateText(cloned.customPolicy))
    ) {
      return reject('invalid_request');
    }

    const normalized: {
      prompt: string;
      includeCategories: boolean;
      response?: string;
      image?: NormalizedImage;
      customPolicy?: string;
    } = {
      prompt: cloned.prompt,
      includeCategories: cloned.includeCategories,
    };
    if (Object.hasOwn(cloned, 'response')) normalized.response = cloned.response as string;
    if (Object.hasOwn(cloned, 'image')) normalized.image = normalizeImage(cloned.image);
    if (Object.hasOwn(cloned, 'customPolicy')) {
      normalized.customPolicy = cloned.customPolicy as string;
    }
    return normalized;
  } catch (error: unknown) {
    if (error instanceof NvidiaSafetyNimError) throw error;
    return reject('invalid_request');
  }
};

const buildTransportRequest = (
  baseUrl: string,
  timeoutMs: number,
  input: NormalizedClassificationRequest,
): NvidiaSafetyNimTransportRequest => {
  const userContent: Array<NvidiaSafetyNimTextContent | NvidiaSafetyNimImageContent> = [
    { type: 'text', text: input.prompt },
  ];
  if (input.image) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${input.image.mediaType};base64,${input.image.base64}` },
    });
  }
  const messages: NvidiaSafetyNimMessage[] = [{ role: 'user', content: userContent }];
  if (input.response !== undefined) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: input.response }],
    });
  }
  const chatTemplate: {
    request_categories: '/categories' | '/no_categories';
    enable_thinking: false;
    custom_policy?: string;
  } = {
    request_categories: input.includeCategories ? '/categories' : '/no_categories',
    enable_thinking: false,
  };
  if (input.customPolicy !== undefined) chatTemplate.custom_policy = input.customPolicy;

  const body: NvidiaSafetyNimRequestBody = {
    model: NVIDIA_SAFETY_NIM_MODEL,
    messages,
    max_tokens: 100,
    temperature: 0.01,
    top_p: 0.95,
    chat_template_kwargs: chatTemplate,
  };
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
    return reject('invalid_request');
  }
  return deepFreeze({
    contractVersion: NVIDIA_SAFETY_NIM_TRANSPORT_VERSION,
    method: 'POST',
    url: `${baseUrl}/v1/chat/completions`,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
    timeoutMs,
  });
};

const normalizeTransportResponse = (
  value: unknown,
): { readonly status: 200; readonly content: string } | { readonly status: number } => {
  try {
    const cloned = inspectAndClone(value, RESPONSE_LIMITS);
    if (!isRecord(cloned) || cloned.contractVersion !== NVIDIA_SAFETY_NIM_TRANSPORT_VERSION) {
      return reject('invalid_response');
    }
    if (
      cloned.status === 200 &&
      hasExactKeys(cloned, ['contractVersion', 'status', 'content']) &&
      typeof cloned.content === 'string' &&
      cloned.content.length <= MAX_RESPONSE_CODE_UNITS &&
      Buffer.byteLength(cloned.content, 'utf8') <= MAX_RESPONSE_BYTES
    ) {
      return { status: 200, content: cloned.content };
    }
    if (
      Number.isInteger(cloned.status) &&
      (cloned.status as number) >= 400 &&
      (cloned.status as number) <= 599 &&
      hasExactKeys(cloned, ['contractVersion', 'status'])
    ) {
      return { status: cloned.status as number };
    }
    return reject('invalid_response');
  } catch (error: unknown) {
    if (error instanceof NvidiaSafetyNimError) throw error;
    return reject('invalid_response');
  }
};

const parseVerdictLine = (line: string, prefix: string): NvidiaSafetyVerdict => {
  if (line === `${prefix}safe`) return 'safe';
  if (line === `${prefix}unsafe`) return 'unsafe';
  return reject('invalid_response');
};

const validCategory = (category: string): boolean => {
  if (
    category.length === 0 ||
    category.length > MAX_CATEGORY_CODE_UNITS ||
    Buffer.byteLength(category, 'utf8') > MAX_CATEGORY_BYTES ||
    CONTROL_PATTERN.test(category)
  ) {
    return false;
  }
  const segments = category.split(', ');
  if (segments.join(', ') !== category) return false;
  return segments.every(
    (segment) => segment.length > 0 && segment.trim() === segment && !segment.includes(','),
  );
};

const parseSafetyContent = (
  content: string,
  input: NormalizedClassificationRequest,
): NvidiaSafetyNimClassificationResult => {
  if (content.includes('\r') || content.endsWith('\n')) return reject('invalid_response');
  const lines = content.split('\n');
  let index = 0;
  const userSafety = parseVerdictLine(lines[index] ?? '', 'User Safety: ');
  index += 1;
  let responseSafety: NvidiaSafetyVerdict | undefined;
  if (input.response !== undefined) {
    responseSafety = parseVerdictLine(lines[index] ?? '', 'Response Safety: ');
    index += 1;
  }

  const categoryRequired =
    input.includeCategories && (userSafety === 'unsafe' || responseSafety === 'unsafe');
  let safetyCategories: string | undefined;
  if (categoryRequired) {
    const line = lines[index] ?? '';
    const prefix = 'Safety Categories: ';
    if (!line.startsWith(prefix)) return reject('invalid_response');
    const category = line.slice(prefix.length);
    if (!validCategory(category)) return reject('invalid_response');
    safetyCategories = category;
    index += 1;
  }
  if (index !== lines.length) return reject('invalid_response');

  const result: {
    contractVersion: typeof NVIDIA_SAFETY_NIM_CONTRACT_VERSION;
    model: typeof NVIDIA_SAFETY_NIM_MODEL;
    userSafety: NvidiaSafetyVerdict;
    responseSafety?: NvidiaSafetyVerdict;
    safetyCategories?: string;
  } = {
    contractVersion: NVIDIA_SAFETY_NIM_CONTRACT_VERSION,
    model: NVIDIA_SAFETY_NIM_MODEL,
    userSafety,
  };
  if (responseSafety !== undefined) result.responseSafety = responseSafety;
  if (safetyCategories !== undefined) result.safetyCategories = safetyCategories;
  return deepFreeze(result);
};

const observe = <T>(promise: Promise<T>): Promise<T> => {
  void promise.catch(() => undefined);
  return promise;
};

export class NvidiaSafetyNimConnector {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly sendRequest: NvidiaSafetyNimTransport['send'];

  constructor(configuration: unknown, transport: unknown) {
    const normalized = normalizeConfiguration(configuration);
    this.baseUrl = normalized.baseUrl;
    this.timeoutMs = normalized.timeoutMs;
    this.sendRequest = normalizeTransport(transport);
  }

  classify(input: unknown): Promise<NvidiaSafetyNimClassificationResult> {
    return observe(this.classifyOnce(input));
  }

  private async classifyOnce(input: unknown): Promise<NvidiaSafetyNimClassificationResult> {
    const normalized = normalizeRequest(input);
    const request = buildTransportRequest(this.baseUrl, this.timeoutMs, normalized);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sent: Promise<unknown>;
    try {
      sent = Promise.resolve(this.sendRequest(request)).catch(() =>
        reject('transport_failure'),
      );
    } catch {
      sent = Promise.reject(new NvidiaSafetyNimError('transport_failure'));
    }
    observe(sent);
    const timeout = observe(
      new Promise<never>((_resolve, rejectPromise) => {
        timer = setTimeout(
          () => rejectPromise(new NvidiaSafetyNimError('transport_timeout')),
          this.timeoutMs,
        );
      }),
    );

    try {
      const raw = await Promise.race([sent, timeout]);
      const response = normalizeTransportResponse(raw);
      if (!('content' in response)) return reject('provider_error');
      return parseSafetyContent(response.content, normalized);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

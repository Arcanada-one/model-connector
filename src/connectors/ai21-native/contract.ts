const INVALID_INPUT = 'AI21_NATIVE_INVALID_INPUT';
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const REQUIRED_REQUEST_KEYS = [
  'apiVersion',
  'operation',
  'model',
  'messages',
  'max_tokens',
  'n',
  'stream',
] as const;
const OPTIONAL_REQUEST_KEYS = ['temperature', 'top_p', 'stop'] as const;
const ALLOWED_MODELS = ['jamba-large-1.7-2025-07', 'jamba-mini-2-2026-01'] as const;
const ALLOWED_MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
const ALLOWED_FINISH_REASONS = new Set(['stop', 'length']);

function invalid(): never {
  throw new Error(INVALID_INPUT);
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) freezeDeep(descriptor.value, seen);
  }
  return Object.freeze(value);
}

export const AI21_NATIVE_LIMITS = freezeDeep({
  maxDepth: 8,
  maxKeysPerObject: 32,
  maxArrayLength: 128,
  maxMessages: 128,
  maxChoices: 16,
  maxStringBytes: 262_144,
  maxAggregateInputBytes: 1_048_576,
  maxResponseBytes: 4_194_304,
  maxSseEvents: 8_192,
});

export const AI21_NATIVE_CHAT_CONTRACT = freezeDeep({
  provider: 'ai21-native',
  service: 'ai21-platform-native-saas',
  apiVersion: 'v1',
  operation: 'chat.completions.create',
  method: 'POST',
  url: 'https://api.ai21.com/studio/v1/chat/completions',
  contentType: 'application/json',
  authorization: {
    scheme: 'Bearer',
    owner: 'caller',
  },
  models: [...ALLOWED_MODELS],
  retryCount: 0,
});

interface InspectionState {
  readonly active: WeakSet<object>;
  readonly maxAggregateBytes: number;
  aggregateBytes: number;
}

function addBytes(state: InspectionState, value: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > AI21_NATIVE_LIMITS.maxStringBytes) invalid();
  state.aggregateBytes += bytes;
  if (state.aggregateBytes > state.maxAggregateBytes) invalid();
}

function inspectSafeValue(value: unknown, maxAggregateBytes: number): void {
  const state: InspectionState = {
    active: new WeakSet<object>(),
    maxAggregateBytes,
    aggregateBytes: 0,
  };
  inspectValue(value, 0, state);
}

function inspectValue(value: unknown, depth: number, state: InspectionState): void {
  if (depth > AI21_NATIVE_LIMITS.maxDepth) invalid();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    addBytes(state, value);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return;
  }
  if (typeof value !== 'object') invalid();
  if (state.active.has(value)) invalid();

  state.active.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === 'symbol')) invalid();

    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.get || descriptor.set) invalid();
    }

    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) invalid();
      if (value.length > AI21_NATIVE_LIMITS.maxArrayLength) invalid();
      const descriptorKeys = Object.keys(descriptors);
      const elementKeys = descriptorKeys.filter((key) => key !== 'length');
      if (
        descriptorKeys.length !== value.length + 1 ||
        elementKeys.length !== value.length ||
        elementKeys.some((key, index) => key !== String(index))
      ) {
        invalid();
      }
      for (const key of elementKeys) {
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor)) invalid();
        inspectValue(descriptor.value, depth + 1, state);
      }
      return;
    }

    if (prototype !== Object.prototype && prototype !== null) invalid();
    const recordKeys = Object.keys(descriptors);
    if (recordKeys.length > AI21_NATIVE_LIMITS.maxKeysPerObject) invalid();
    for (const key of recordKeys) {
      if (POLLUTION_KEYS.has(key)) invalid();
      addBytes(state, key);
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) invalid();
      inspectValue(descriptor.value, depth + 1, state);
    }
  } catch {
    invalid();
  } finally {
    state.active.delete(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!hasOwn(record, key)) invalid();
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid();
  }
}

function asBoundedString(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string') invalid();
  if (!allowEmpty && value.length === 0) invalid();
  if (Buffer.byteLength(value, 'utf8') > AI21_NATIVE_LIMITS.maxStringBytes) invalid();
  return value;
}

function asInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    invalid();
  }
  return value;
}

function asNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid();
  }
  return value;
}

export interface Ai21NativeMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Ai21NativeRequestBody {
  model: (typeof ALLOWED_MODELS)[number];
  messages: Ai21NativeMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  n: number;
  stream: boolean;
}

export interface Ai21NativeRequestDescriptor {
  provider: 'ai21-native';
  method: 'POST';
  url: 'https://api.ai21.com/studio/v1/chat/completions';
  headers: {
    'Content-Type': 'application/json';
  };
  authorization: {
    scheme: 'Bearer';
    owner: 'caller';
  };
  retryCount: 0;
  body: Ai21NativeRequestBody;
}

function parseMessages(value: unknown): Ai21NativeMessage[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > AI21_NATIVE_LIMITS.maxMessages
  ) {
    invalid();
  }
  return value.map((item) => {
    const message = asRecord(item);
    assertExactKeys(message, ['role', 'content']);
    if (typeof message.role !== 'string' || !ALLOWED_MESSAGE_ROLES.has(message.role)) invalid();
    const content = asBoundedString(message.content, true);
    return {
      role: message.role as Ai21NativeMessage['role'],
      content,
    };
  });
}

function parseStop(value: unknown): string | string[] {
  if (typeof value === 'string') return asBoundedString(value, true);
  if (!Array.isArray(value) || value.length > AI21_NATIVE_LIMITS.maxArrayLength) invalid();
  return value.map((item) => asBoundedString(item, true));
}

export function buildAi21NativeChatRequest(input: unknown): Ai21NativeRequestDescriptor {
  inspectSafeValue(input, AI21_NATIVE_LIMITS.maxAggregateInputBytes);
  const record = asRecord(input);
  assertExactKeys(record, REQUIRED_REQUEST_KEYS, OPTIONAL_REQUEST_KEYS);

  if (record.apiVersion !== AI21_NATIVE_CHAT_CONTRACT.apiVersion) invalid();
  if (record.operation !== AI21_NATIVE_CHAT_CONTRACT.operation) invalid();
  if (
    typeof record.model !== 'string' ||
    !ALLOWED_MODELS.includes(record.model as (typeof ALLOWED_MODELS)[number])
  ) {
    invalid();
  }
  if (typeof record.stream !== 'boolean') invalid();

  const body: Ai21NativeRequestBody = {
    model: record.model as Ai21NativeRequestBody['model'],
    messages: parseMessages(record.messages),
    max_tokens: asInteger(record.max_tokens, 1, 4_096),
    n: asInteger(record.n, 1, 16),
    stream: record.stream,
  };

  if (body.stream && body.n !== 1) invalid();
  if (hasOwn(record, 'temperature')) body.temperature = asNumber(record.temperature, 0, 2);
  if (hasOwn(record, 'top_p')) body.top_p = asNumber(record.top_p, 0, 1);
  if (hasOwn(record, 'stop')) body.stop = parseStop(record.stop);

  return freezeDeep({
    provider: 'ai21-native',
    method: 'POST',
    url: 'https://api.ai21.com/studio/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
    },
    authorization: {
      scheme: 'Bearer',
      owner: 'caller',
    },
    retryCount: 0,
    body,
  });
}

export interface Ai21NativeUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface Ai21NativeResponseChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string;
  };
  finish_reason: 'stop' | 'length';
}

export interface Ai21NativeChatResponse {
  id: string;
  choices: Ai21NativeResponseChoice[];
  usage: Ai21NativeUsage;
}

function parseUsage(value: unknown): Ai21NativeUsage {
  const usage = asRecord(value);
  assertExactKeys(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']);
  const promptTokens = asInteger(usage.prompt_tokens, 0, Number.MAX_SAFE_INTEGER);
  const completionTokens = asInteger(usage.completion_tokens, 0, Number.MAX_SAFE_INTEGER);
  const totalTokens = asInteger(usage.total_tokens, 0, Number.MAX_SAFE_INTEGER);
  if (promptTokens + completionTokens !== totalTokens) invalid();
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function parseFinishReason(value: unknown): 'stop' | 'length' {
  if (typeof value !== 'string' || !ALLOWED_FINISH_REASONS.has(value)) invalid();
  return value as 'stop' | 'length';
}

export function parseAi21NativeChatResponse(input: unknown): Ai21NativeChatResponse {
  inspectSafeValue(input, AI21_NATIVE_LIMITS.maxResponseBytes);
  const record = asRecord(input);
  assertExactKeys(record, ['id', 'choices', 'usage']);
  const id = asBoundedString(record.id);
  if (
    !Array.isArray(record.choices) ||
    record.choices.length === 0 ||
    record.choices.length > AI21_NATIVE_LIMITS.maxChoices
  ) {
    invalid();
  }

  const indexes = new Set<number>();
  const choices = record.choices.map((item) => {
    const choice = asRecord(item);
    assertExactKeys(choice, ['index', 'message', 'finish_reason']);
    const index = asInteger(choice.index, 0, Number.MAX_SAFE_INTEGER);
    if (indexes.has(index)) invalid();
    indexes.add(index);

    const message = asRecord(choice.message);
    assertExactKeys(message, ['role', 'content']);
    if (message.role !== 'assistant') invalid();

    return {
      index,
      message: {
        role: 'assistant' as const,
        content: asBoundedString(message.content, true),
      },
      finish_reason: parseFinishReason(choice.finish_reason),
    };
  });

  return freezeDeep({
    id,
    choices,
    usage: parseUsage(record.usage),
  });
}

interface ParsedSseChunk {
  id: string;
  index: number;
  role?: 'assistant';
  content?: string;
  finishReason: 'stop' | 'length' | null;
  usage: Ai21NativeUsage | null;
}

function parseSseChunk(value: unknown): ParsedSseChunk {
  inspectSafeValue(value, AI21_NATIVE_LIMITS.maxResponseBytes);
  const chunk = asRecord(value);
  assertExactKeys(chunk, ['id', 'choices', 'usage']);
  const id = asBoundedString(chunk.id);
  if (!Array.isArray(chunk.choices) || chunk.choices.length !== 1) invalid();

  const choice = asRecord(chunk.choices[0]);
  assertExactKeys(choice, ['index', 'delta', 'finish_reason']);
  const index = asInteger(choice.index, 0, Number.MAX_SAFE_INTEGER);
  if (index !== 0) invalid();

  const delta = asRecord(choice.delta);
  const deltaKeys = Object.keys(delta);
  if (deltaKeys.length !== 1) invalid();

  let role: 'assistant' | undefined;
  let content: string | undefined;
  if (hasOwn(delta, 'role')) {
    if (delta.role !== 'assistant') invalid();
    role = 'assistant';
  } else if (hasOwn(delta, 'content')) {
    content = asBoundedString(delta.content, true);
  } else {
    invalid();
  }

  let finishReason: 'stop' | 'length' | null = null;
  if (choice.finish_reason !== null) finishReason = parseFinishReason(choice.finish_reason);
  const usage = chunk.usage === null ? null : parseUsage(chunk.usage);

  return {
    id,
    index,
    role,
    content,
    finishReason,
    usage,
  };
}

export interface Ai21NativeSseResult {
  id: string;
  role: 'assistant';
  content: string;
  finish_reason: 'stop' | 'length';
  usage: Ai21NativeUsage;
  event_count: number;
}

export function parseAi21NativeChatSse(transcript: unknown): Ai21NativeSseResult {
  if (typeof transcript !== 'string') invalid();
  if (Buffer.byteLength(transcript, 'utf8') > AI21_NATIVE_LIMITS.maxResponseBytes) invalid();

  const dataLines: string[] = [];
  for (const line of transcript.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (!line.startsWith('data: ')) invalid();
    dataLines.push(line.slice(6));
  }
  if (dataLines.length === 0) invalid();

  let done = false;
  let terminal = false;
  let requestId: string | undefined;
  let roleSeen = false;
  let finishReason: 'stop' | 'length' | undefined;
  let usage: Ai21NativeUsage | undefined;
  let content = '';
  let eventCount = 0;

  for (const data of dataLines) {
    if (done) invalid();
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    if (terminal) invalid();
    eventCount += 1;
    if (eventCount > AI21_NATIVE_LIMITS.maxSseEvents) invalid();

    let decoded: unknown;
    try {
      decoded = JSON.parse(data) as unknown;
    } catch {
      invalid();
    }
    const chunk = parseSseChunk(decoded);
    if (requestId === undefined) requestId = chunk.id;
    if (chunk.id !== requestId) invalid();

    if (!roleSeen) {
      if (chunk.role !== 'assistant' || chunk.content !== undefined) invalid();
      if (chunk.finishReason !== null || chunk.usage !== null) invalid();
      roleSeen = true;
      continue;
    }

    if (chunk.role !== undefined || chunk.content === undefined) invalid();
    content += chunk.content;
    if (Buffer.byteLength(content, 'utf8') > AI21_NATIVE_LIMITS.maxResponseBytes) invalid();

    if (chunk.finishReason === null) {
      if (chunk.usage !== null) invalid();
      continue;
    }
    if (chunk.usage === null) invalid();
    terminal = true;
    finishReason = chunk.finishReason;
    usage = chunk.usage;
  }

  if (!done || !terminal || !roleSeen || requestId === undefined || !finishReason || !usage) {
    invalid();
  }

  return freezeDeep({
    id: requestId,
    role: 'assistant',
    content,
    finish_reason: finishReason,
    usage,
    event_count: eventCount,
  });
}

export type Ai21NativeFailureCode =
  | 'unauthorized'
  | 'access_denied'
  | 'invalid_request'
  | 'rate_limited'
  | 'internal_error'
  | 'unavailable'
  | 'upstream_error'
  | 'timeout';

export interface Ai21NativeFailure {
  provider: 'ai21-native';
  code: Ai21NativeFailureCode;
  status?: number;
  retry: false;
}

const HTTP_FAILURE_CODES: Readonly<Record<number, Ai21NativeFailureCode>> = freezeDeep({
  401: 'unauthorized',
  403: 'access_denied',
  422: 'invalid_request',
  429: 'rate_limited',
  500: 'internal_error',
  503: 'unavailable',
});

export function classifyAi21NativeFailure(input: unknown): Ai21NativeFailure {
  inspectSafeValue(input, 1_024);
  const record = asRecord(input);
  if (record.kind === 'timeout') {
    assertExactKeys(record, ['kind']);
    return freezeDeep({
      provider: 'ai21-native',
      code: 'timeout',
      retry: false,
    });
  }
  if (record.kind !== 'http') invalid();
  assertExactKeys(record, ['kind', 'status']);
  const status = asInteger(record.status, 400, 599);
  return freezeDeep({
    provider: 'ai21-native',
    code: HTTP_FAILURE_CODES[status] ?? 'upstream_error',
    status,
    retry: false,
  });
}

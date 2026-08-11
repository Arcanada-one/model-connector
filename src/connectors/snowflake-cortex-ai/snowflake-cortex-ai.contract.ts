export const SNOWFLAKE_CORTEX_LIMITS = Object.freeze({
  maxDepth: 8,
  maxKeysPerRecord: 16,
  maxArrayItems: 64,
  maxTotalNodes: 512,
  maxAccountUrlBytes: 512,
  maxModelBytes: 256,
  maxMessageContentBytes: 32_768,
  maxRequestBytes: 262_144,
  maxResponseBytes: 1_048_576,
  maxCompletionTokens: 32_768,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 120_000,
  defaultTimeoutMs: 30_000,
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const REQUEST_KEYS = [
  'accountUrl',
  'model',
  'messages',
  'maxCompletionTokens',
  'temperature',
  'topP',
  'timeoutMs',
] as const;
const MESSAGE_KEYS = ['role', 'content'] as const;
const RESPONSE_KEYS = ['id', 'object', 'created', 'model', 'choices', 'usage'] as const;
const CHOICE_KEYS = ['index', 'message', 'finish_reason'] as const;
const RESPONSE_MESSAGE_KEYS = ['role', 'content'] as const;
const USAGE_KEYS = ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const;

type JsonRecord = Record<string, unknown>;
type MessageRole = 'system' | 'user' | 'assistant';

export class SnowflakeCortexContractError extends Error {
  constructor() {
    super('Invalid Snowflake Cortex contract input.');
    this.name = 'SnowflakeCortexContractError';
  }
}

export interface SnowflakeCortexChatDescriptor {
  readonly kind: 'snowflake-cortex-chat-completions-offline-descriptor';
  readonly performsIo: false;
  readonly authorizationOwner: 'caller';
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<{
    Accept: 'application/json';
    'Content-Type': 'application/json';
  }>;
  readonly body: Readonly<{
    model: string;
    messages: ReadonlyArray<Readonly<{ role: MessageRole; content: string }>>;
    stream: false;
    max_completion_tokens?: number;
    temperature?: number;
    top_p?: number;
  }>;
  readonly timeoutMs: number;
  readonly maxAttempts: 1;
}

export interface SnowflakeCortexChatResponse {
  readonly id: string;
  readonly object: 'chat.completion';
  readonly created: number;
  readonly model: string;
  readonly choices: ReadonlyArray<
    Readonly<{
      index: number;
      message: Readonly<{ role: 'assistant'; content: string }>;
      finish_reason: string | null;
    }>
  >;
  readonly usage: Readonly<{
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }>;
}

export interface SnowflakeCortexFailure {
  readonly kind: 'snowflake-cortex-chat-failure';
  readonly code:
    | 'BAD_REQUEST'
    | 'BUDGET_EXCEEDED'
    | 'FORBIDDEN'
    | 'QUOTA_EXCEEDED'
    | 'TIMEOUT'
    | 'HTTP_ERROR'
    | 'TRANSPORT_ERROR';
  readonly message: string;
  readonly retryable: false;
  readonly status?: number;
  readonly timeoutMs?: number;
}

function invalid(): never {
  throw new SnowflakeCortexContractError();
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function copySafeUnknown(input: unknown, maximumBytes: number): unknown {
  let nodes = 0;
  const active = new Set<object>();

  const visit = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > SNOWFLAKE_CORTEX_LIMITS.maxTotalNodes) invalid();
    if (depth > SNOWFLAKE_CORTEX_LIMITS.maxDepth) invalid();

    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (utf8Bytes(value) > maximumBytes) invalid();
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid();
      return value;
    }
    if (typeof value !== 'object') invalid();

    const objectValue = value as object;
    if (active.has(objectValue)) invalid();
    active.add(objectValue);

    try {
      const prototype = Object.getPrototypeOf(objectValue) as object | null;
      const symbols = Object.getOwnPropertySymbols(objectValue);
      const descriptors = Object.getOwnPropertyDescriptors(objectValue);
      if (symbols.length !== 0) invalid();

      if (Array.isArray(objectValue)) {
        if (prototype !== Array.prototype) invalid();
        if (objectValue.length > SNOWFLAKE_CORTEX_LIMITS.maxArrayItems) invalid();

        const descriptorKeys = Object.keys(descriptors).filter((key) => key !== 'length');
        if (descriptorKeys.length !== objectValue.length) invalid();

        const copy: unknown[] = [];
        for (let index = 0; index < objectValue.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
          copy.push(visit(descriptor.value, depth + 1));
        }
        return copy;
      }

      if (prototype !== Object.prototype && prototype !== null) invalid();
      const keys = Object.keys(descriptors);
      if (keys.length > SNOWFLAKE_CORTEX_LIMITS.maxKeysPerRecord) invalid();

      const copy: JsonRecord = {};
      for (const key of keys) {
        if (FORBIDDEN_KEYS.has(key)) invalid();
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
        copy[key] = visit(descriptor.value, depth + 1);
      }
      return copy;
    } catch (error) {
      if (error instanceof SnowflakeCortexContractError) throw error;
      return invalid();
    } finally {
      active.delete(objectValue);
    }
  };

  const copy = visit(input, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(copy);
  } catch {
    return invalid();
  }
  if (utf8Bytes(serialized) > maximumBytes) invalid();
  return copy;
}

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, allowed: readonly string[], required = allowed): void {
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.includes(key))) invalid();
  if (required.some((key) => !Object.hasOwn(record, key))) invalid();
}

function boundedString(value: unknown, maximumBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string') invalid();
  if ((!allowEmpty && value.length === 0) || utf8Bytes(value) > maximumBytes) invalid();
  return value;
}

function integerInRange(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid();
  }
  return value as number;
}

function finiteInRange(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid();
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeAccountBase(value: unknown): string {
  const accountUrl = boundedString(value, SNOWFLAKE_CORTEX_LIMITS.maxAccountUrlBytes);
  let parsed: URL;
  try {
    parsed = new URL(accountUrl);
  } catch {
    return invalid();
  }

  const hostname = parsed.hostname.toLowerCase();
  const suffix = '.snowflakecomputing.com';
  const accountPrefix = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : '';
  const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    accountPrefix === '' ||
    !accountPrefix.split('.').every((label) => validLabel.test(label))
  ) {
    invalid();
  }
  return `https://${hostname}`;
}

export function buildSnowflakeCortexChatDescriptor(input: unknown): SnowflakeCortexChatDescriptor {
  const record = asRecord(copySafeUnknown(input, SNOWFLAKE_CORTEX_LIMITS.maxRequestBytes));
  exactKeys(record, REQUEST_KEYS, ['accountUrl', 'model', 'messages']);

  const accountBase = normalizeAccountBase(record.accountUrl);
  const model = boundedString(record.model, SNOWFLAKE_CORTEX_LIMITS.maxModelBytes);
  if (!Array.isArray(record.messages) || record.messages.length === 0) invalid();

  const messages = record.messages.map((candidate): { role: MessageRole; content: string } => {
    const message = asRecord(candidate);
    exactKeys(message, MESSAGE_KEYS);
    const role = message.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') invalid();
    return {
      role,
      content: boundedString(
        message.content,
        SNOWFLAKE_CORTEX_LIMITS.maxMessageContentBytes,
        true,
      ),
    };
  });

  const body: {
    model: string;
    messages: Array<{ role: MessageRole; content: string }>;
    stream: false;
    max_completion_tokens?: number;
    temperature?: number;
    top_p?: number;
  } = { model, messages, stream: false };

  if (record.maxCompletionTokens !== undefined) {
    body.max_completion_tokens = integerInRange(
      record.maxCompletionTokens,
      1,
      SNOWFLAKE_CORTEX_LIMITS.maxCompletionTokens,
    );
  }
  if (record.temperature !== undefined) {
    body.temperature = finiteInRange(record.temperature, 0, 2);
  }
  if (record.topP !== undefined) body.top_p = finiteInRange(record.topP, 0, 1);

  if (utf8Bytes(JSON.stringify(body)) > SNOWFLAKE_CORTEX_LIMITS.maxRequestBytes) invalid();
  const timeoutMs =
    record.timeoutMs === undefined
      ? SNOWFLAKE_CORTEX_LIMITS.defaultTimeoutMs
      : integerInRange(
          record.timeoutMs,
          SNOWFLAKE_CORTEX_LIMITS.minTimeoutMs,
          SNOWFLAKE_CORTEX_LIMITS.maxTimeoutMs,
        );

  return deepFreeze({
    kind: 'snowflake-cortex-chat-completions-offline-descriptor',
    performsIo: false,
    authorizationOwner: 'caller',
    method: 'POST',
    url: `${accountBase}/api/v2/cortex/v1/chat/completions`,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
    timeoutMs,
    maxAttempts: 1,
  });
}

export function parseSnowflakeCortexChatResponse(input: unknown): SnowflakeCortexChatResponse {
  const record = asRecord(copySafeUnknown(input, SNOWFLAKE_CORTEX_LIMITS.maxResponseBytes));
  exactKeys(record, RESPONSE_KEYS);

  const id = boundedString(record.id, 512);
  if (record.object !== 'chat.completion') invalid();
  const created = integerInRange(record.created, 0, Number.MAX_SAFE_INTEGER);
  const model = boundedString(record.model, SNOWFLAKE_CORTEX_LIMITS.maxModelBytes);
  if (!Array.isArray(record.choices) || record.choices.length === 0) invalid();

  const choices = record.choices.map((candidate) => {
    const choice = asRecord(candidate);
    exactKeys(choice, CHOICE_KEYS);
    const message = asRecord(choice.message);
    exactKeys(message, RESPONSE_MESSAGE_KEYS);
    if (message.role !== 'assistant') invalid();
    if (choice.finish_reason !== null && typeof choice.finish_reason !== 'string') invalid();
    if (typeof choice.finish_reason === 'string' && utf8Bytes(choice.finish_reason) > 256) invalid();

    return {
      index: integerInRange(choice.index, 0, Number.MAX_SAFE_INTEGER),
      message: {
        role: 'assistant' as const,
        content: boundedString(message.content, SNOWFLAKE_CORTEX_LIMITS.maxResponseBytes, true),
      },
      finish_reason: choice.finish_reason as string | null,
    };
  });

  const usageRecord = asRecord(record.usage);
  exactKeys(usageRecord, USAGE_KEYS);
  const promptTokens = integerInRange(usageRecord.prompt_tokens, 0, Number.MAX_SAFE_INTEGER);
  const completionTokens = integerInRange(
    usageRecord.completion_tokens,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const totalTokens = integerInRange(usageRecord.total_tokens, 0, Number.MAX_SAFE_INTEGER);
  if (promptTokens + completionTokens !== totalTokens) invalid();

  return deepFreeze({
    id,
    object: 'chat.completion',
    created,
    model,
    choices,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
  });
}

export function normalizeSnowflakeCortexFailure(input: unknown): SnowflakeCortexFailure {
  const record = asRecord(copySafeUnknown(input, 4_096));
  if (record.kind === 'http') {
    exactKeys(record, ['kind', 'status']);
    const status = integerInRange(record.status, 100, 599);
    const mapping: Partial<Record<number, { code: SnowflakeCortexFailure['code']; message: string }>> = {
      400: { code: 'BAD_REQUEST', message: 'Snowflake rejected the documented request profile.' },
      402: { code: 'BUDGET_EXCEEDED', message: 'Snowflake reported an exceeded budget.' },
      403: { code: 'FORBIDDEN', message: 'Snowflake denied account or role access.' },
      429: { code: 'QUOTA_EXCEEDED', message: 'Snowflake reported an account or model quota limit.' },
      503: { code: 'TIMEOUT', message: 'Snowflake reported an operation timeout.' },
    };
    const classified = mapping[status] ?? {
      code: 'HTTP_ERROR' as const,
      message: 'Snowflake returned an unclassified HTTP failure.',
    };
    return deepFreeze({
      kind: 'snowflake-cortex-chat-failure',
      code: classified.code,
      message: classified.message,
      retryable: false,
      status,
    });
  }

  if (record.kind === 'timeout') {
    exactKeys(record, ['kind', 'timeoutMs']);
    const timeoutMs = integerInRange(
      record.timeoutMs,
      SNOWFLAKE_CORTEX_LIMITS.minTimeoutMs,
      SNOWFLAKE_CORTEX_LIMITS.maxTimeoutMs,
    );
    return deepFreeze({
      kind: 'snowflake-cortex-chat-failure',
      code: 'TIMEOUT',
      message: 'The caller-reported operation timed out.',
      retryable: false,
      timeoutMs,
    });
  }

  if (record.kind === 'transport') {
    exactKeys(record, ['kind']);
    return deepFreeze({
      kind: 'snowflake-cortex-chat-failure',
      code: 'TRANSPORT_ERROR',
      message: 'The caller-reported transport failed.',
      retryable: false,
    });
  }

  return invalid();
}

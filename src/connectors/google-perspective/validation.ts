import {
  SCORE_TYPES,
  TEXT_TYPES,
  type AnalyzeCommentInput,
  type AnalyzeCommentResult,
  type AttributeParameters,
  type PerspectiveAttributeScores,
  type PerspectiveScore,
  type PerspectiveSpanScore,
  type ScoreType,
  type TextEntry,
} from './types';

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DEPTH = 12;
const MAX_NODES = 2_048;
const MAX_KEYS = 128;
const MAX_ARRAY_LENGTH = 128;
const MAX_STRING_LENGTH = 32_768;
const MAX_METADATA_LENGTH = 8_192;

export class PerspectiveValidationFailure extends Error {}

interface SafetyBudget {
  nodes: number;
  seen: WeakSet<object>;
}

const fail = (): never => {
  throw new PerspectiveValidationFailure();
};

const descriptorsFor = (value: object): Record<string, PropertyDescriptor> => {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail();
  }
};

const assertSafeNode = (value: unknown, depth: number, budget: SafetyBudget): void => {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) fail();

  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) fail();
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail();
    return;
  }
  if (typeof value !== 'object') fail();

  const objectValue = value as object;
  if (budget.seen.has(objectValue)) fail();
  budget.seen.add(objectValue);

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(objectValue) as object | null;
  } catch {
    return fail();
  }

  if (Array.isArray(objectValue)) {
    if (prototype !== Array.prototype || objectValue.length > MAX_ARRAY_LENGTH) fail();
    const descriptors = descriptorsFor(objectValue);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length') continue;
      if (!/^\d+$/.test(key) || descriptor.get || descriptor.set || !('value' in descriptor)) fail();
      assertSafeNode(descriptor.value, depth + 1, budget);
    }
    budget.seen.delete(objectValue);
    return;
  }

  if (prototype !== Object.prototype && prototype !== null) fail();
  const descriptors = descriptorsFor(objectValue);
  const keys = Object.keys(descriptors);
  if (keys.length > MAX_KEYS) fail();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      DANGEROUS_KEYS.has(key) ||
      descriptor.get ||
      descriptor.set ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      fail();
    }
    assertSafeNode(descriptor.value, depth + 1, budget);
  }
  budget.seen.delete(objectValue);
};

export const assertSafeValue = (value: unknown): void => {
  assertSafeNode(value, 0, { nodes: 0, seen: new WeakSet<object>() });
};

export const asRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value as object) as object | null;
  if (prototype !== Object.prototype && prototype !== null) fail();
  return value as Record<string, unknown>;
};

export const assertExactKeys = (record: Record<string, unknown>, allowed: readonly string[]): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key) || DANGEROUS_KEYS.has(key)) fail();
  }
};

const hasOwn = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const safeObject = <T extends object>(): T => Object.create(null) as T;

const copyTextEntry = (value: unknown): TextEntry => {
  const record = asRecord(value);
  assertExactKeys(record, ['text', 'type']);
  const text = record.text;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_STRING_LENGTH) {
    fail();
  }
  const result = safeObject<TextEntry>();
  result.text = text as string;
  if (hasOwn(record, 'type')) {
    if (typeof record.type !== 'string' || !TEXT_TYPES.includes(record.type as never)) fail();
    result.type = record.type as TextEntry['type'];
  }
  return result;
};

const copyAttributeParameters = (value: unknown): AttributeParameters => {
  const record = asRecord(value);
  assertExactKeys(record, ['scoreThreshold', 'scoreType']);
  const result = safeObject<AttributeParameters>();
  let scoreType: ScoreType | undefined;
  if (hasOwn(record, 'scoreType')) {
    if (typeof record.scoreType !== 'string' || !SCORE_TYPES.includes(record.scoreType as never)) fail();
    scoreType = record.scoreType as ScoreType;
    result.scoreType = scoreType;
  }
  if (hasOwn(record, 'scoreThreshold')) {
    const threshold = record.scoreThreshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) fail();
    if (
      scoreType === undefined ||
      scoreType === 'SCORE_TYPE_UNSPECIFIED' ||
      scoreType === 'PROBABILITY' ||
      scoreType === 'PERCENTILE'
    ) {
      if ((threshold as number) < 0 || (threshold as number) > 1) fail();
    }
    result.scoreThreshold = threshold as number;
  }
  return result;
};

const copyContext = (value: unknown): Record<string, unknown> => {
  const record = asRecord(value);
  assertExactKeys(record, ['entries', 'articleAndParentComment']);
  const hasEntries = hasOwn(record, 'entries');
  const hasArticle = hasOwn(record, 'articleAndParentComment');
  if (hasEntries === hasArticle) fail();
  const result = safeObject<Record<string, unknown>>();
  if (hasEntries) {
    const entries = record.entries;
    if (!Array.isArray(entries)) fail();
    result.entries = (entries as unknown[]).map(copyTextEntry);
    return result;
  }

  const article = asRecord(record.articleAndParentComment);
  assertExactKeys(article, ['article', 'parentComment']);
  if (!hasOwn(article, 'article') && !hasOwn(article, 'parentComment')) fail();
  const copied = safeObject<Record<string, unknown>>();
  if (hasOwn(article, 'article')) copied.article = copyTextEntry(article.article);
  if (hasOwn(article, 'parentComment')) copied.parentComment = copyTextEntry(article.parentComment);
  result.articleAndParentComment = copied;
  return result;
};

const copyOptionalMetadata = (
  source: Record<string, unknown>,
  destination: Record<string, unknown>,
  key: 'clientToken' | 'communityId' | 'sessionId',
): void => {
  if (!hasOwn(source, key)) return;
  const value = source[key];
  if (typeof value !== 'string' || value.length > MAX_METADATA_LENGTH) fail();
  destination[key] = value;
};

export const buildAnalyzeBody = (
  input: AnalyzeCommentInput,
  allowProviderStorage: boolean,
): Record<string, unknown> => {
  assertSafeValue(input);
  const record = asRecord(input);
  assertExactKeys(record, [
    'comment',
    'requestedAttributes',
    'languages',
    'context',
    'doNotStore',
    'spanAnnotations',
    'clientToken',
    'communityId',
    'sessionId',
  ]);
  if (!hasOwn(record, 'comment') || !hasOwn(record, 'requestedAttributes')) fail();
  if (hasOwn(record, 'languages')) fail();

  const requestedAttributes = asRecord(record.requestedAttributes);
  assertExactKeys(requestedAttributes, ['TOXICITY']);
  if (!hasOwn(requestedAttributes, 'TOXICITY')) fail();

  const body = safeObject<Record<string, unknown>>();
  body.comment = copyTextEntry(record.comment);
  const copiedAttributes = safeObject<Record<string, unknown>>();
  copiedAttributes.TOXICITY = copyAttributeParameters(requestedAttributes.TOXICITY);
  body.requestedAttributes = copiedAttributes;

  if (hasOwn(record, 'context')) body.context = copyContext(record.context);
  if (hasOwn(record, 'spanAnnotations')) {
    if (typeof record.spanAnnotations !== 'boolean') fail();
    body.spanAnnotations = record.spanAnnotations;
  }
  copyOptionalMetadata(record, body, 'clientToken');
  copyOptionalMetadata(record, body, 'communityId');
  copyOptionalMetadata(record, body, 'sessionId');

  if (hasOwn(record, 'doNotStore')) {
    if (typeof record.doNotStore !== 'boolean') fail();
    if (!record.doNotStore && !allowProviderStorage) fail();
    body.doNotStore = record.doNotStore;
  } else if (!allowProviderStorage) {
    body.doNotStore = true;
  }
  return body;
};

const copyScore = (value: unknown): PerspectiveScore => {
  const record = asRecord(value);
  assertExactKeys(record, ['value', 'type']);
  const scoreValue = record.value;
  if (typeof scoreValue !== 'number' || !Number.isFinite(scoreValue)) fail();
  const result = safeObject<PerspectiveScore>();
  result.value = scoreValue as number;
  if (hasOwn(record, 'type')) {
    if (typeof record.type !== 'string' || !SCORE_TYPES.includes(record.type as never)) fail();
    result.type = record.type as ScoreType;
    if (
      (result.type === 'PROBABILITY' || result.type === 'PERCENTILE') &&
      (result.value < 0 || result.value > 1)
    ) {
      fail();
    }
  }
  return result;
};

const copySpan = (value: unknown, commentLength: number): PerspectiveSpanScore => {
  const record = asRecord(value);
  assertExactKeys(record, ['begin', 'end', 'score']);
  if (!hasOwn(record, 'score')) fail();
  const hasBegin = hasOwn(record, 'begin');
  const hasEnd = hasOwn(record, 'end');
  if (hasBegin !== hasEnd) fail();

  const result = safeObject<PerspectiveSpanScore>();
  if (hasBegin && hasEnd) {
    if (!Number.isInteger(record.begin) || !Number.isInteger(record.end)) fail();
    const begin = record.begin as number;
    const end = record.end as number;
    if (begin < 0 || end < begin || end > commentLength) fail();
    result.begin = begin;
    result.end = end;
  }
  result.score = copyScore(record.score);
  return result;
};

const copyAttributeScores = (value: unknown, commentLength: number): PerspectiveAttributeScores => {
  const record = asRecord(value);
  assertExactKeys(record, ['summaryScore', 'spanScores']);
  const result = safeObject<PerspectiveAttributeScores>();
  if (hasOwn(record, 'summaryScore')) result.summaryScore = copyScore(record.summaryScore);
  if (hasOwn(record, 'spanScores')) {
    const spanScores = record.spanScores;
    if (!Array.isArray(spanScores)) fail();
    result.spanScores = (spanScores as unknown[]).map((span: unknown) =>
      copySpan(span, commentLength),
    );
  }
  return result;
};

const copyStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) fail();
  const arrayValue = value as unknown[];
  return arrayValue.map((item: unknown) => {
    if (typeof item !== 'string' || item.length > MAX_METADATA_LENGTH) return fail();
    return item;
  });
};

export const parseAnalyzeResponse = (value: unknown, commentLength: number): AnalyzeCommentResult => {
  assertSafeValue(value);
  const record = asRecord(value);
  assertExactKeys(record, ['attributeScores', 'clientToken', 'detectedLanguages', 'languages']);
  if (!hasOwn(record, 'attributeScores')) fail();
  const attributes = asRecord(record.attributeScores);
  assertExactKeys(attributes, ['TOXICITY']);
  if (!hasOwn(attributes, 'TOXICITY')) fail();

  const result = safeObject<AnalyzeCommentResult>();
  const scores = safeObject<Record<'TOXICITY', PerspectiveAttributeScores>>();
  scores.TOXICITY = copyAttributeScores(attributes.TOXICITY, commentLength);
  result.attributeScores = scores;
  if (hasOwn(record, 'clientToken')) {
    const clientToken = record.clientToken;
    if (typeof clientToken !== 'string' || clientToken.length > MAX_METADATA_LENGTH) fail();
    result.clientToken = clientToken as string;
  }
  if (hasOwn(record, 'detectedLanguages')) {
    result.detectedLanguages = copyStringArray(record.detectedLanguages);
  }
  if (hasOwn(record, 'languages')) result.languages = copyStringArray(record.languages);
  return result;
};

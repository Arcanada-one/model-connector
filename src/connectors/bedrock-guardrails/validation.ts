import { BedrockGuardrailsError } from './types';

const IDENTIFIER = /^(?:[a-z0-9]+|arn:aws(?:-[a-z0-9-]+)?:bedrock:[a-z0-9-]{1,20}:[0-9]{12}:guardrail\/[a-z0-9]+)$/;
const VERSION = /^(?:DRAFT|[1-9][0-9]{0,7})$/;
const NUMERIC_VERSION = /^[1-9][0-9]{0,7}$/;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/;
const NAME = /^[0-9A-Za-z_-]+$/;
const MAX_POLICY_DEPTH = 12;
const MAX_POLICY_NODES = 10_000;
const MAX_POLICY_STRING = 100_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8000;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

export function record(
  value: unknown,
  code: 'invalid_config' | 'invalid_request' | 'invalid_response' | 'signing_error',
  label: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new BedrockGuardrailsError(code, `${label} must be a plain object`);
  return value;
}

export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: 'invalid_config' | 'invalid_request' | 'invalid_response' | 'signing_error',
  label: string,
): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new BedrockGuardrailsError(code, `${label} contains an unsupported field`);
  }
}

function boundedString(
  value: unknown,
  min: number,
  max: number,
  label: string,
): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\r\n]/.test(value)) {
    throw new BedrockGuardrailsError('invalid_request', `${label} is invalid`);
  }
  return value;
}

export function validateRegion(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32 || !REGION.test(value)) {
    throw new BedrockGuardrailsError('invalid_config', 'Bedrock region is invalid');
  }
  return value;
}

export function validateIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || !IDENTIFIER.test(value)) {
    throw new BedrockGuardrailsError('invalid_request', 'Guardrail identifier is invalid');
  }
  return value;
}

export function validateVersion(value: unknown, allowDraft = true): string {
  if (typeof value !== 'string' || !(allowDraft ? VERSION : NUMERIC_VERSION).test(value)) {
    throw new BedrockGuardrailsError('invalid_request', 'Guardrail version is invalid');
  }
  return value;
}

export function cloneSafeJson(value: unknown, label: string): unknown {
  const active = new Set<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_POLICY_NODES || depth > MAX_POLICY_DEPTH) {
      throw new BedrockGuardrailsError('invalid_request', `${label} is too complex`);
    }
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new BedrockGuardrailsError('invalid_request', `${label} contains an invalid number`);
      return current;
    }
    if (typeof current === 'string') {
      if (current.length > MAX_POLICY_STRING) throw new BedrockGuardrailsError('invalid_request', `${label} contains an oversized string`);
      return current;
    }
    if (typeof current !== 'object') throw new BedrockGuardrailsError('invalid_request', `${label} contains an unsupported value`);
    if (active.has(current)) throw new BedrockGuardrailsError('invalid_request', `${label} is cyclic`);
    active.add(current);
    try {
      if (Array.isArray(current)) return current.map((entry) => visit(entry, depth + 1));
      if (!isPlainRecord(current)) throw new BedrockGuardrailsError('invalid_request', `${label} must contain plain objects`);
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
          throw new BedrockGuardrailsError('invalid_request', `${label} contains a forbidden field`);
        }
        output[key] = visit(entry, depth + 1);
      }
      return output;
    } finally {
      active.delete(current);
    }
  };

  return visit(value, 0);
}

const POLICY_FIELDS = [
  'automatedReasoningPolicyConfig',
  'contentPolicyConfig',
  'contextualGroundingPolicyConfig',
  'crossRegionConfig',
  'sensitiveInformationPolicyConfig',
  'topicPolicyConfig',
  'wordPolicyConfig',
] as const;

function policyObject(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  const object = record(value, 'invalid_request', label);
  exactKeys(object, allowed, 'invalid_request', label);
  return object;
}

function policyItems(value: unknown, label: string, allowed: readonly string[]): void {
  if (!Array.isArray(value)) throw new BedrockGuardrailsError('invalid_request', `${label} must be an array`);
  for (const entry of value) policyObject(entry, `${label} item`, allowed);
}

function normalizePolicy(field: (typeof POLICY_FIELDS)[number], value: unknown): unknown {
  if (field === 'automatedReasoningPolicyConfig') {
    const config = policyObject(value, field, ['confidenceThreshold', 'policies']);
    if (!Array.isArray(config.policies) || config.policies.length < 1 || config.policies.length > 2 || !config.policies.every((policy) => typeof policy === 'string')) {
      throw new BedrockGuardrailsError('invalid_request', `${field}.policies is invalid`);
    }
    if (config.confidenceThreshold !== undefined && (typeof config.confidenceThreshold !== 'number' || config.confidenceThreshold < 0 || config.confidenceThreshold > 1)) {
      throw new BedrockGuardrailsError('invalid_request', `${field}.confidenceThreshold is invalid`);
    }
  } else if (field === 'contentPolicyConfig') {
    const config = policyObject(value, field, ['filtersConfig', 'tierConfig']);
    policyItems(config.filtersConfig, `${field}.filtersConfig`, [
      'inputAction', 'inputEnabled', 'inputModalities', 'inputStrength',
      'outputAction', 'outputEnabled', 'outputModalities', 'outputStrength', 'type',
    ]);
    if (config.tierConfig !== undefined) policyObject(config.tierConfig, `${field}.tierConfig`, ['tierName']);
  } else if (field === 'contextualGroundingPolicyConfig') {
    const config = policyObject(value, field, ['filtersConfig']);
    policyItems(config.filtersConfig, `${field}.filtersConfig`, [
      'action', 'enabled', 'inputAction', 'inputEnabled', 'outputAction',
      'outputEnabled', 'threshold', 'type',
    ]);
  } else if (field === 'crossRegionConfig') {
    policyObject(value, field, ['guardrailProfileIdentifier']);
  } else if (field === 'sensitiveInformationPolicyConfig') {
    const config = policyObject(value, field, ['piiEntitiesConfig', 'regexesConfig']);
    if (config.piiEntitiesConfig !== undefined) {
      policyItems(config.piiEntitiesConfig, `${field}.piiEntitiesConfig`, [
        'action', 'inputAction', 'inputEnabled', 'outputAction', 'outputEnabled', 'type',
      ]);
    }
    if (config.regexesConfig !== undefined) {
      policyItems(config.regexesConfig, `${field}.regexesConfig`, [
        'action', 'description', 'inputAction', 'inputEnabled', 'name',
        'outputAction', 'outputEnabled', 'pattern',
      ]);
    }
  } else if (field === 'topicPolicyConfig') {
    const config = policyObject(value, field, ['tierConfig', 'topicsConfig']);
    if (config.tierConfig !== undefined) policyObject(config.tierConfig, `${field}.tierConfig`, ['tierName']);
    policyItems(config.topicsConfig, `${field}.topicsConfig`, [
      'definition', 'examples', 'inputAction', 'inputEnabled', 'name',
      'outputAction', 'outputEnabled', 'type',
    ]);
  } else if (field === 'wordPolicyConfig') {
    const config = policyObject(value, field, ['managedWordListsConfig', 'wordsConfig']);
    if (config.managedWordListsConfig !== undefined) {
      policyItems(config.managedWordListsConfig, `${field}.managedWordListsConfig`, [
        'inputAction', 'inputEnabled', 'outputAction', 'outputEnabled', 'type',
      ]);
    }
    if (config.wordsConfig !== undefined) {
      policyItems(config.wordsConfig, `${field}.wordsConfig`, [
        'inputAction', 'inputEnabled', 'outputAction', 'outputEnabled', 'text',
      ]);
    }
  }
  return cloneSafeJson(value, field);
}

export function normalizeGuardrailBody(input: unknown, update: boolean): {
  identifier?: string;
  body: Record<string, unknown>;
} {
  const value = record(input, 'invalid_request', update ? 'UpdateGuardrail input' : 'CreateGuardrail input');
  exactKeys(
    value,
    [
      ...(update ? ['guardrailIdentifier'] : ['clientRequestToken', 'tags']),
      'name',
      'description',
      'blockedInputMessaging',
      'blockedOutputsMessaging',
      'kmsKeyId',
      ...POLICY_FIELDS,
    ],
    'invalid_request',
    update ? 'UpdateGuardrail input' : 'CreateGuardrail input',
  );
  const name = boundedString(value.name, 1, 50, 'Guardrail name');
  if (!NAME.test(name)) throw new BedrockGuardrailsError('invalid_request', 'Guardrail name is invalid');
  const body: Record<string, unknown> = {
    name,
    blockedInputMessaging: boundedString(value.blockedInputMessaging, 1, 500, 'Blocked input message'),
    blockedOutputsMessaging: boundedString(value.blockedOutputsMessaging, 1, 500, 'Blocked output message'),
  };
  if (value.description !== undefined) body.description = boundedString(value.description, 1, 200, 'Description');
  if (value.kmsKeyId !== undefined) body.kmsKeyId = boundedString(value.kmsKeyId, 1, 2048, 'KMS key');
  for (const field of POLICY_FIELDS) {
    if (value[field] !== undefined) body[field] = normalizePolicy(field, value[field]);
  }
  if (!update && value.clientRequestToken !== undefined) {
    body.clientRequestToken = boundedString(value.clientRequestToken, 1, 256, 'Client request token');
  }
  if (!update && value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > 200) throw new BedrockGuardrailsError('invalid_request', 'Tags are invalid');
    body.tags = value.tags.map((tag) => {
      const item = record(tag, 'invalid_request', 'Tag');
      exactKeys(item, ['key', 'value'], 'invalid_request', 'Tag');
      return {
        key: boundedString(item.key, 1, 128, 'Tag key'),
        value: boundedString(item.value, 0, 256, 'Tag value'),
      };
    });
  }
  return {
    ...(update ? { identifier: validateIdentifier(value.guardrailIdentifier) } : {}),
    body,
  };
}

function canonicalBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new BedrockGuardrailsError('invalid_request', 'Image bytes must be canonical base64');
  }
  const maxEncoded = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
  if (value.length > maxEncoded) throw new BedrockGuardrailsError('invalid_request', 'Image exceeds the size limit');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.length > MAX_IMAGE_BYTES || decoded.toString('base64') !== value) {
    throw new BedrockGuardrailsError('invalid_request', 'Image bytes must be canonical base64');
  }
  return decoded;
}

function pngDimensions(bytes: Buffer): [number, number] | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function jpegDimensions(bytes: Buffer): [number, number] | undefined {
  if (bytes.length < 11 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 7) return undefined;
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  return undefined;
}

export function normalizeApplyBody(input: unknown): {
  identifier: string;
  version: string;
  body: Record<string, unknown>;
} {
  const value = record(input, 'invalid_request', 'ApplyGuardrail input');
  exactKeys(value, ['guardrailIdentifier', 'guardrailVersion', 'content', 'source', 'outputScope'], 'invalid_request', 'ApplyGuardrail input');
  const identifier = validateIdentifier(value.guardrailIdentifier);
  const version = validateVersion(value.guardrailVersion);
  if (value.source !== 'INPUT' && value.source !== 'OUTPUT') throw new BedrockGuardrailsError('invalid_request', 'Apply source is invalid');
  if (value.outputScope !== undefined && value.outputScope !== 'INTERVENTIONS' && value.outputScope !== 'FULL') throw new BedrockGuardrailsError('invalid_request', 'Output scope is invalid');
  if (!Array.isArray(value.content) || value.content.length === 0) throw new BedrockGuardrailsError('invalid_request', 'Apply content is invalid');
  let imageCount = 0;
  const content = value.content.map((entry) => {
    const block = record(entry, 'invalid_request', 'Content block');
    exactKeys(block, ['text', 'image'], 'invalid_request', 'Content block');
    if ((block.text === undefined) === (block.image === undefined)) throw new BedrockGuardrailsError('invalid_request', 'Content block must contain exactly one member');
    if (block.text !== undefined) {
      const text = record(block.text, 'invalid_request', 'Text block');
      exactKeys(text, ['text', 'qualifiers'], 'invalid_request', 'Text block');
      if (typeof text.text !== 'string' || text.text.length === 0) throw new BedrockGuardrailsError('invalid_request', 'Text content is invalid');
      const normalized: Record<string, unknown> = { text: text.text };
      if (text.qualifiers !== undefined) {
        const allowed = new Set(['grounding_source', 'query', 'guard_content']);
        if (!Array.isArray(text.qualifiers) || text.qualifiers.length === 0 || text.qualifiers.length > 3 || new Set(text.qualifiers).size !== text.qualifiers.length || !text.qualifiers.every((qualifier) => typeof qualifier === 'string' && allowed.has(qualifier))) {
          throw new BedrockGuardrailsError('invalid_request', 'Text qualifiers are invalid');
        }
        normalized.qualifiers = [...text.qualifiers];
      }
      return { text: normalized };
    }
    imageCount += 1;
    if (imageCount > 20) throw new BedrockGuardrailsError('invalid_request', 'Apply content exceeds the image count limit');
    const image = record(block.image, 'invalid_request', 'Image block');
    exactKeys(image, ['format', 'source'], 'invalid_request', 'Image block');
    if (image.format !== 'png' && image.format !== 'jpeg') throw new BedrockGuardrailsError('invalid_request', 'Image format is invalid');
    const source = record(image.source, 'invalid_request', 'Image source');
    exactKeys(source, ['bytes'], 'invalid_request', 'Image source');
    const bytes = canonicalBase64(source.bytes);
    const dimensions = image.format === 'png' ? pngDimensions(bytes) : jpegDimensions(bytes);
    if (!dimensions || dimensions[0] < 1 || dimensions[1] < 1 || dimensions[0] > MAX_IMAGE_DIMENSION || dimensions[1] > MAX_IMAGE_DIMENSION) {
      throw new BedrockGuardrailsError('invalid_request', 'Image dimensions or signature are invalid');
    }
    return { image: { format: image.format, source: { bytes: source.bytes } } };
  });
  const body: Record<string, unknown> = { content, source: value.source };
  if (value.outputScope !== undefined) body.outputScope = value.outputScope;
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 128 * 1024 * 1024) throw new BedrockGuardrailsError('invalid_request', 'Apply request exceeds the local safety ceiling');
  return { identifier, version, body };
}

// CONN-0089 — JSON Schema → @arcanada/output-guard SchemaValidator adapter.
// LRU-cached ajv compile keyed by canonical schema-hash.

import { createHash } from 'node:crypto';
import type { ValidationResult } from '@arcanada/output-guard';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import { OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT } from '../dto/execute.dto';

export type JsonSchema = Record<string, unknown>;
export type SchemaValidator<T = unknown> = (data: unknown) => ValidationResult<T>;

const CACHE_MAX = 64;
const cache = new Map<string, ValidateFunction>();
let sharedAjv: Ajv | null = null;

function getAjv(): Ajv {
  if (!sharedAjv) {
    sharedAjv = new Ajv({
      allErrors: true,
      strict: false,
      coerceTypes: false,
      useDefaults: false,
    });
    addFormats(sharedAjv);
  }
  return sharedAjv;
}

function hashSchema(schema: JsonSchema): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

function evict(): void {
  if (cache.size <= CACHE_MAX) return;
  const first = cache.keys().next().value;
  if (first !== undefined) cache.delete(first);
}

/**
 * Build a SchemaValidator compatible with `@arcanada/output-guard` from a
 * JSON-Schema-shaped record. Caches compiled validators by content hash.
 *
 * Throws on:
 *  - schema not a plain object,
 *  - schema body exceeds {@link OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT} bytes,
 *  - ajv compilation failure (invalid keyword/format).
 */
export function buildAjvAdapter<T = unknown>(schema: JsonSchema): SchemaValidator<T> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('schema must be a plain object');
  }
  const serialized = JSON.stringify(schema);
  if (serialized.length > OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT) {
    throw new Error(
      `schema exceeds ${OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT}-byte limit (got ${serialized.length})`,
    );
  }
  const key = hashSchema(schema);
  let validate = cache.get(key);
  if (!validate) {
    validate = getAjv().compile(schema);
    cache.set(key, validate);
    evict();
  }

  return (data: unknown): ValidationResult<T> => {
    const ok = validate!(data);
    if (ok) {
      return { valid: true, data: data as T };
    }
    const errors = (validate!.errors ?? []).map(
      (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
    );
    return { valid: false, errors };
  };
}

/** Test hook — drop the LRU cache. */
export function _resetAjvAdapterCacheForTesting(): void {
  cache.clear();
  sharedAjv = null;
}

export function _getAjvAdapterCacheSizeForTesting(): number {
  return cache.size;
}

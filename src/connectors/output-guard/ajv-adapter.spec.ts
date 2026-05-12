import { beforeEach, describe, expect, it } from 'vitest';

import {
  _getAjvAdapterCacheSizeForTesting,
  _resetAjvAdapterCacheForTesting,
  buildAjvAdapter,
} from './ajv-adapter';
import { OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT } from '../dto/execute.dto';

describe('buildAjvAdapter', () => {
  beforeEach(() => {
    _resetAjvAdapterCacheForTesting();
  });

  it('compiles a simple object schema and returns valid=true on match', () => {
    const validate = buildAjvAdapter({
      type: 'object',
      properties: { name: { type: 'string' }, value: { type: 'number' } },
      required: ['name', 'value'],
      additionalProperties: false,
    });
    const out = validate({ name: 'x', value: 1 });
    expect(out.valid).toBe(true);
    expect(out.data).toEqual({ name: 'x', value: 1 });
  });

  it('returns valid=false with formatted error path on schema mismatch', () => {
    const validate = buildAjvAdapter({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    const out = validate({ name: 42 });
    expect(out.valid).toBe(false);
    expect(out.errors).toBeDefined();
    expect(out.errors!.join(' ')).toMatch(/string|name/i);
  });

  it('reuses the compiled validator across calls with identical schema', () => {
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    buildAjvAdapter(schema);
    expect(_getAjvAdapterCacheSizeForTesting()).toBe(1);
    buildAjvAdapter({ ...schema });
    // Same canonical JSON → same hash → single cache entry.
    expect(_getAjvAdapterCacheSizeForTesting()).toBe(1);
  });

  it('caches separate validators for distinct schemas', () => {
    buildAjvAdapter({ type: 'string' });
    buildAjvAdapter({ type: 'number' });
    expect(_getAjvAdapterCacheSizeForTesting()).toBe(2);
  });

  it('rejects schema exceeding the size limit', () => {
    const oversize = { x: 'a'.repeat(OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT) };
    expect(() => buildAjvAdapter(oversize)).toThrow(/limit/);
  });

  it('rejects non-object schema input', () => {
    // @ts-expect-error — runtime guard
    expect(() => buildAjvAdapter(null)).toThrow();
    // @ts-expect-error — runtime guard
    expect(() => buildAjvAdapter([])).toThrow();
  });

  it('supports ajv-formats keywords (email)', () => {
    const validate = buildAjvAdapter({
      type: 'string',
      format: 'email',
    });
    expect(validate('a@b.co').valid).toBe(true);
    expect(validate('not-an-email').valid).toBe(false);
  });
});

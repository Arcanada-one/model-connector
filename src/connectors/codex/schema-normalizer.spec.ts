import { describe, it, expect } from 'vitest';
import { normalizeSchema, SchemaNormalizationError } from './schema-normalizer';

describe('normalizeSchema', () => {
  describe('positive cases (round-trip identity for already-strict schemas)', () => {
    it('should pass through a flat strict object schema unchanged', () => {
      const input = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      };
      const out = normalizeSchema(input);
      expect(out).toEqual(input);
    });

    it('should normalize nested object schema to additionalProperties:false + required', () => {
      const input = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
        },
      };
      const out = normalizeSchema(input);
      expect(out).toMatchObject({
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
        },
        required: ['user'],
        additionalProperties: false,
      });
    });

    it('should normalize array of objects', () => {
      const input = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      };
      const out = normalizeSchema(input) as Record<string, unknown>;
      expect((out.properties as Record<string, unknown>).items).toMatchObject({
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
        },
      });
    });
  });

  describe('negative cases (rejections)', () => {
    it('should reject top-level anyOf', () => {
      const input = { anyOf: [{ type: 'string' }, { type: 'number' }] };
      expect(() => normalizeSchema(input)).toThrow(SchemaNormalizationError);
      expect(() => normalizeSchema(input)).toThrow(/anyOf/);
    });

    it('should reject inline self-references', () => {
      const input = {
        type: 'object',
        properties: { self: { $ref: '#' } },
      };
      expect(() => normalizeSchema(input)).toThrow(SchemaNormalizationError);
      expect(() => normalizeSchema(input)).toThrow(/self-ref/i);
    });

    it('should reject schemas exceeding max depth (>5)', () => {
      const deep = (n: number): Record<string, unknown> =>
        n === 0 ? { type: 'string' } : { type: 'object', properties: { nested: deep(n - 1) } };
      const tooDeep = deep(7);
      expect(() => normalizeSchema(tooDeep)).toThrow(/depth/i);
    });

    it('should reject schemas exceeding max size (64KB)', () => {
      const big = 'x'.repeat(65 * 1024);
      const input = { type: 'object', properties: { data: { type: 'string', description: big } } };
      expect(() => normalizeSchema(input)).toThrow(/size|64/i);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { sanitizeJsonResponse, JsonSanitizeError } from './json-sanitizer';

describe('sanitizeJsonResponse', () => {
  it('should parse clean JSON object', () => {
    const result = sanitizeJsonResponse('{"key": "value"}');
    expect(result.json).toEqual({ key: 'value' });
    expect(result.wasClean).toBe(true);
  });

  it('should parse clean JSON array', () => {
    const result = sanitizeJsonResponse('[1, 2, 3]');
    expect(result.json).toEqual([1, 2, 3]);
    expect(result.wasClean).toBe(true);
  });

  it('should strip BOM and whitespace', () => {
    const result = sanitizeJsonResponse('\uFEFF  {"key": "value"}  ');
    expect(result.json).toEqual({ key: 'value' });
    expect(result.wasClean).toBe(true);
  });

  it('should strip markdown json code fence', () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = sanitizeJsonResponse(input);
    expect(result.json).toEqual({ key: 'value' });
    expect(result.wasClean).toBe(false);
  });

  it('should strip markdown code fence without language', () => {
    const input = '```\n{"key": "value"}\n```';
    const result = sanitizeJsonResponse(input);
    expect(result.json).toEqual({ key: 'value' });
    expect(result.wasClean).toBe(false);
  });

  it('should extract JSON from surrounding text', () => {
    const input = 'Here is the result:\n{"key": "value"}\nEnd of result.';
    const result = sanitizeJsonResponse(input);
    expect(result.json).toEqual({ key: 'value' });
    expect(result.wasClean).toBe(false);
  });

  it('should extract JSON array from surrounding text', () => {
    const input = 'The answer is: [1, 2, 3] done.';
    const result = sanitizeJsonResponse(input);
    expect(result.json).toEqual([1, 2, 3]);
    expect(result.wasClean).toBe(false);
  });

  it('should handle nested JSON objects', () => {
    const input = '```json\n{"a": {"b": {"c": 1}}}\n```';
    const result = sanitizeJsonResponse(input);
    expect(result.json).toEqual({ a: { b: { c: 1 } } });
    expect(result.wasClean).toBe(false);
  });

  it('should handle code fence in the middle of text', () => {
    const input = 'Some preamble text\n```json\n{"result": true}\n```\nSome trailing text';
    const result = sanitizeJsonResponse(input);
    expect(result.json).toEqual({ result: true });
    expect(result.wasClean).toBe(false);
  });

  it('should throw on empty input', () => {
    expect(() => sanitizeJsonResponse('')).toThrow(JsonSanitizeError);
    expect(() => sanitizeJsonResponse('   ')).toThrow(JsonSanitizeError);
  });

  it('should throw on non-JSON text', () => {
    expect(() => sanitizeJsonResponse('Hello world')).toThrow(JsonSanitizeError);
  });

  it('should throw on invalid JSON with brackets', () => {
    expect(() => sanitizeJsonResponse('{not valid json}')).toThrow(JsonSanitizeError);
  });

  it('should prefer object when it comes first', () => {
    const input = '{"items": [1, 2]}';
    const result = sanitizeJsonResponse(input);
    expect(result.json).toEqual({ items: [1, 2] });
    expect(result.wasClean).toBe(true);
  });

  it('should prefer array when it comes first', () => {
    const input = 'Result: [{"a": 1}]';
    const result = sanitizeJsonResponse(input);
    expect(result.json).toEqual([{ a: 1 }]);
    expect(result.wasClean).toBe(false);
  });
});

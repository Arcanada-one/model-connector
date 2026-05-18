import { describe, it, expect } from 'vitest';
import {
  imageGenerateRequestSchema,
  executeRequestSchema,
  OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT,
} from './execute.dto';

// ARCA-0011 — multi-modal prompt union ----------------------------------------
describe('executeRequestSchema (ARCA-0011 ContentBlock union)', () => {
  const base = { connector: 'openrouter' } as const;
  const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo=';

  it('accepts string prompt (backward-compat)', () => {
    const r = executeRequestSchema.safeParse({ ...base, prompt: 'hello' });
    expect(r.success).toBe(true);
  });

  it('accepts ContentBlock[] prompt with text-only block', () => {
    const r = executeRequestSchema.safeParse({
      ...base,
      prompt: [{ type: 'text', text: 'describe' }],
    });
    expect(r.success).toBe(true);
  });

  it('accepts ContentBlock[] with text + image_url blocks', () => {
    const r = executeRequestSchema.safeParse({
      ...base,
      prompt: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: pngDataUrl } },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('accepts image_url with optional detail field', () => {
    const r = executeRequestSchema.safeParse({
      ...base,
      prompt: [{ type: 'image_url', image_url: { url: pngDataUrl, detail: 'high' } }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty ContentBlock array', () => {
    const r = executeRequestSchema.safeParse({ ...base, prompt: [] });
    expect(r.success).toBe(false);
  });

  it('rejects ContentBlock array exceeding 20 items', () => {
    const blocks = Array.from({ length: 21 }, () => ({ type: 'text', text: 'x' }));
    const r = executeRequestSchema.safeParse({ ...base, prompt: blocks });
    expect(r.success).toBe(false);
  });

  it('rejects image_url that is not a data: URL', () => {
    const r = executeRequestSchema.safeParse({
      ...base,
      prompt: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects image_url with unsupported media type', () => {
    const r = executeRequestSchema.safeParse({
      ...base,
      prompt: [{ type: 'image_url', image_url: { url: 'data:image/bmp;base64,XXX' } }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown block type', () => {
    const r = executeRequestSchema.safeParse({
      ...base,
      prompt: [{ type: 'audio', text: 'oops' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty string prompt', () => {
    const r = executeRequestSchema.safeParse({ ...base, prompt: '' });
    expect(r.success).toBe(false);
  });
});

// CONN-0089 — output_format + schema validation -------------------------------
describe('executeRequestSchema (CONN-0089 output-guard fields)', () => {
  const base = { connector: 'openrouter', prompt: 'hello' } as const;

  it('accepts output_format=json with a valid schema record', () => {
    const result = executeRequestSchema.safeParse({
      ...base,
      output_format: 'json',
      schema: { type: 'object', properties: { x: { type: 'number' } } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts all enum values: json|yaml|toml|python|auto', () => {
    for (const fmt of ['json', 'yaml', 'toml', 'python', 'auto'] as const) {
      const r = executeRequestSchema.safeParse({ ...base, output_format: fmt });
      expect(r.success, `format=${fmt}`).toBe(true);
    }
  });

  it('rejects unknown output_format value', () => {
    const result = executeRequestSchema.safeParse({
      ...base,
      output_format: 'xml',
    });
    expect(result.success).toBe(false);
  });

  it('rejects schema exceeding 32 KiB size limit', () => {
    const oversize = { padding: 'a'.repeat(OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT) };
    const result = executeRequestSchema.safeParse({
      ...base,
      output_format: 'json',
      schema: oversize,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(' ');
      expect(msg).toMatch(/32768/);
    }
  });

  it('accepts schema right at the size boundary', () => {
    // Build a schema whose JSON.stringify ≤ limit (-2 to leave room for {} brace + key)
    const fill = 'a'.repeat(OUTPUT_FORMAT_SCHEMA_SIZE_LIMIT - 100);
    const result = executeRequestSchema.safeParse({
      ...base,
      output_format: 'json',
      schema: { description: fill },
    });
    expect(result.success).toBe(true);
  });

  it('accepts request without output_format (backward-compat)', () => {
    const result = executeRequestSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.output_format).toBeUndefined();
      expect(result.data.schema).toBeUndefined();
    }
  });
});

describe('imageGenerateRequestSchema', () => {
  describe('maxBudgetUsd validation (G2)', () => {
    it('accepts $0.01 (positive budget)', () => {
      const result = imageGenerateRequestSchema.safeParse({
        prompt: 'test',
        maxBudgetUsd: 0.01,
      });
      expect(result.success).toBe(true);
    });

    it('rejects $0 (zero budget is not a valid limit)', () => {
      const result = imageGenerateRequestSchema.safeParse({
        prompt: 'test',
        maxBudgetUsd: 0,
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative budget', () => {
      const result = imageGenerateRequestSchema.safeParse({
        prompt: 'test',
        maxBudgetUsd: -1,
      });
      expect(result.success).toBe(false);
    });

    it('accepts absent maxBudgetUsd (optional field)', () => {
      const result = imageGenerateRequestSchema.safeParse({ prompt: 'test' });
      expect(result.success).toBe(true);
    });
  });
});

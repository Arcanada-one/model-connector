import { describe, it, expect } from 'vitest';
import { openAiTranscriptionResponseSchema } from './openai.schema';

describe('openAiTranscriptionResponseSchema', () => {
  it('accepts a non-empty transcription with usage', () => {
    const fixture = {
      text: 'The quick brown fox',
      usage: { type: 'tokens', total_tokens: 186, input_tokens: 137, output_tokens: 49 },
    };
    const parsed = openAiTranscriptionResponseSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.usage?.input_tokens).toBe(137);
  });

  it('accepts an envelope with `text` only (no usage)', () => {
    const parsed = openAiTranscriptionResponseSchema.safeParse({ text: 'hello' });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty transcription (drift signal handled downstream)', () => {
    const parsed = openAiTranscriptionResponseSchema.safeParse({ text: '' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an envelope missing `text` entirely', () => {
    const parsed = openAiTranscriptionResponseSchema.safeParse({ usage: {} });
    expect(parsed.success).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  buildGroqFreeModels,
  GROQ_FREE_MODELS_DEFAULT,
  GROQ_FREE_MODELS_DEFAULT_CSV,
} from './groq.catalogue';

describe('buildGroqFreeModels (CONN-1672)', () => {
  it('returns the curated default when no CSV provided', () => {
    expect(buildGroqFreeModels()).toEqual(GROQ_FREE_MODELS_DEFAULT);
  });

  it('returns the curated default when empty string provided', () => {
    expect(buildGroqFreeModels('')).toEqual(GROQ_FREE_MODELS_DEFAULT);
  });

  it('returns the curated default when whitespace-only string provided', () => {
    expect(buildGroqFreeModels('   ')).toEqual(GROQ_FREE_MODELS_DEFAULT);
  });

  it('parses a CSV override correctly (replaces the default)', () => {
    expect(buildGroqFreeModels('llama-3.3-70b-versatile,allam-2-7b')).toEqual([
      'llama-3.3-70b-versatile',
      'allam-2-7b',
    ]);
  });

  it('trims whitespace and drops empties around CSV entries', () => {
    expect(buildGroqFreeModels(' llama-3.3-70b-versatile , , allam-2-7b ')).toEqual([
      'llama-3.3-70b-versatile',
      'allam-2-7b',
    ]);
  });
});

describe('GROQ_FREE_MODELS_DEFAULT (CONN-1672 — operator-curated free-tier chat)', () => {
  it('contains the 11 operator-curated free-tier groq chat models', () => {
    expect(GROQ_FREE_MODELS_DEFAULT).toEqual([
      'llama-3.1-8b-instant',
      'llama-3.3-70b-versatile',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'meta-llama/llama-prompt-guard-2-22m',
      'meta-llama/llama-prompt-guard-2-86m',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-safeguard-20b',
      'qwen/qwen3-32b',
      'qwen/qwen3.6-27b',
      'allam-2-7b',
    ]);
  });

  it('CSV default is the single source of truth for env.schema (no drift)', () => {
    expect(buildGroqFreeModels(GROQ_FREE_MODELS_DEFAULT_CSV)).toEqual(GROQ_FREE_MODELS_DEFAULT);
  });
});

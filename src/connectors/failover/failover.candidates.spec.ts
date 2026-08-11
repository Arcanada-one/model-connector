// CONN-0243 — failover candidate builder tests (free-first, DeepSeek-first, anti-fabrication).

import { describe, it, expect } from 'vitest';
import { buildFailoverCandidates } from './failover.candidates';
import { ConnectorCapabilities } from '../interfaces/connector.interface';

const DEFAULTS = {
  providerOrder: ['openmodel', 'groq', 'openrouter', 'gemini'],
  deepseekModel: 'deepseek-v4-flash',
  paidEnabled: false,
  allowFreeDowngrade: true,
};

function caps(
  name: string,
  modelMeta: Array<{
    id: string;
    free?: boolean;
    modality?: ConnectorCapabilities['modality'];
  }>,
  freeModels: string[] = [],
): ConnectorCapabilities {
  return {
    name,
    type: 'api',
    models: modelMeta.map((m) => m.id),
    supportsStreaming: false,
    supportsJsonSchema: true,
    supportsTools: false,
    maxTimeout: 120_000,
    freeModels,
    modelMeta,
  };
}

const CAPS: ConnectorCapabilities[] = [
  caps('groq', [{ id: 'llama-3.3-70b-versatile', free: true }]),
  caps('openmodel', [
    { id: 'deepseek-v4-flash', free: true },
    { id: 'qwen3-235b', free: false },
  ]),
  caps('openrouter', [
    { id: 'meta-llama/llama-4-maverick:free', free: true },
    { id: 'anthropic/claude-opus', free: false },
  ]),
];

describe('buildFailoverCandidates', () => {
  it('free-first: DeepSeek free hop is first', () => {
    const result = buildFailoverCandidates({ ...DEFAULTS, capabilities: CAPS });
    expect(result[0]).toEqual({
      connector: 'openmodel',
      model: 'deepseek-v4-flash',
      tier: 'free',
    });
    // every entry is free (paid disabled)
    expect(result.every((c) => c.tier === 'free')).toBe(true);
  });

  it('paid never precedes free (free-before-paid invariant) when paid enabled', () => {
    const result = buildFailoverCandidates({ ...DEFAULTS, capabilities: CAPS, paidEnabled: true });
    const firstPaid = result.findIndex((c) => c.tier === 'paid');
    const lastFree = result.map((c) => c.tier).lastIndexOf('free');
    expect(firstPaid).toBeGreaterThan(lastFree);
    // DeepSeek still first
    expect(result[0].model).toBe('deepseek-v4-flash');
  });

  it('paid disabled → no paid candidates appear', () => {
    const result = buildFailoverCandidates({ ...DEFAULTS, capabilities: CAPS, paidEnabled: false });
    expect(result.some((c) => c.tier === 'paid')).toBe(false);
    expect(result.some((c) => c.model === 'qwen3-235b')).toBe(false);
  });

  it('anti-fabrication: a non-chat model is excluded', () => {
    const withStt = [
      ...CAPS,
      caps('groqx', [{ id: 'whisper-large', free: true, modality: 'speech_to_text' }]),
    ];
    const result = buildFailoverCandidates({ ...DEFAULTS, capabilities: withStt });
    expect(result.some((c) => c.model === 'whisper-large')).toBe(false);
  });

  it('providerOrder respected among free tiers', () => {
    const result = buildFailoverCandidates({ ...DEFAULTS, capabilities: CAPS });
    const connectors = result.map((c) => c.connector);
    // openmodel (deepseek) first, then groq before openrouter per providerOrder
    expect(connectors.indexOf('groq')).toBeLessThan(connectors.indexOf('openrouter'));
  });

  it('requested free model is promoted to front, free chain follows', () => {
    const result = buildFailoverCandidates({
      ...DEFAULTS,
      capabilities: CAPS,
      requestedModel: 'llama-3.3-70b-versatile',
    });
    expect(result[0].model).toBe('llama-3.3-70b-versatile');
    // deepseek still present as fallback
    expect(result.some((c) => c.model === 'deepseek-v4-flash')).toBe(true);
  });

  it('alias "auto" → pure free-first chain (deepseek first)', () => {
    const result = buildFailoverCandidates({
      ...DEFAULTS,
      capabilities: CAPS,
      requestedModel: 'auto',
    });
    expect(result[0].model).toBe('deepseek-v4-flash');
  });

  it('unknown requested id → falls back to free-first chain (gateway behaviour)', () => {
    const result = buildFailoverCandidates({
      ...DEFAULTS,
      capabilities: CAPS,
      requestedModel: 'gpt-5.5-turbo-does-not-exist',
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].model).toBe('deepseek-v4-flash');
  });

  it('requested paid model + allowFreeDowngrade=false → only that model, no free fallback', () => {
    const result = buildFailoverCandidates({
      ...DEFAULTS,
      capabilities: CAPS,
      paidEnabled: true,
      requestedModel: 'anthropic/claude-opus',
      allowFreeDowngrade: false,
    });
    expect(result).toEqual([
      { connector: 'openrouter', model: 'anthropic/claude-opus', tier: 'paid' },
    ]);
  });

  it('requested paid model + allowFreeDowngrade=true → paid first then free fallback', () => {
    const result = buildFailoverCandidates({
      ...DEFAULTS,
      capabilities: CAPS,
      paidEnabled: true,
      requestedModel: 'anthropic/claude-opus',
      allowFreeDowngrade: true,
    });
    expect(result[0].model).toBe('anthropic/claude-opus');
    expect(result.some((c) => c.model === 'deepseek-v4-flash')).toBe(true);
  });

  it('dedupes repeated connector:model', () => {
    const dup = [...CAPS, caps('openmodel', [{ id: 'deepseek-v4-flash', free: true }])];
    const result = buildFailoverCandidates({ ...DEFAULTS, capabilities: dup });
    const keys = result.map((c) => `${c.connector}:${c.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

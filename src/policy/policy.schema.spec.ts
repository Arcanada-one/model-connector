// CONN-1665 — write-time validation of the per-key access policy shape.

import { describe, it, expect } from 'vitest';
import { apiKeyPolicySchema, KEY_OVERRIDE_CAPABLE } from './policy.schema';

describe('apiKeyPolicySchema (CONN-1665)', () => {
  it('accepts the canonical Email Agent policy', () => {
    const policy = {
      policyVersion: 1,
      providers: ['openrouter'],
      models: { mode: 'free-only' },
      providerKeys: { openrouter: 'OPENROUTER_API_KEY_EMAIL_AGENT' },
    };
    expect(apiKeyPolicySchema.parse(policy)).toEqual(policy);
  });

  it('accepts a minimal policy (version only = unrestricted)', () => {
    expect(apiKeyPolicySchema.parse({ policyVersion: 1 })).toEqual({ policyVersion: 1 });
  });

  it('accepts models mode "list" with a non-empty list', () => {
    const policy = {
      policyVersion: 1,
      models: { mode: 'list', list: ['deepseek-v4-flash'] },
    };
    expect(apiKeyPolicySchema.parse(policy)).toEqual(policy);
  });

  it('rejects a wrong policyVersion', () => {
    expect(apiKeyPolicySchema.safeParse({ policyVersion: 2 }).success).toBe(false);
  });

  it('rejects an empty providers array (min 1 when present)', () => {
    expect(apiKeyPolicySchema.safeParse({ policyVersion: 1, providers: [] }).success).toBe(false);
  });

  it('rejects mode "list" without a list (fail-closed at write time)', () => {
    expect(
      apiKeyPolicySchema.safeParse({ policyVersion: 1, models: { mode: 'list' } }).success,
    ).toBe(false);
  });

  it('rejects mode "list" with an empty list', () => {
    expect(
      apiKeyPolicySchema.safeParse({ policyVersion: 1, models: { mode: 'list', list: [] } })
        .success,
    ).toBe(false);
  });

  it('rejects a stray list under mode "all"', () => {
    expect(
      apiKeyPolicySchema.safeParse({
        policyVersion: 1,
        models: { mode: 'all', list: ['x'] },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(apiKeyPolicySchema.safeParse({ policyVersion: 1, extraField: true }).success).toBe(
      false,
    );
  });

  describe('providerKeys (env NAME indirection, override-capable only)', () => {
    it('rejects a value that looks like a key VALUE, not an env var name', () => {
      const result = apiKeyPolicySchema.safeParse({
        policyVersion: 1,
        providerKeys: { openrouter: 'sk-or-v1-abcdef0123456789' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects lowercase / dashed env names', () => {
      for (const bad of ['openrouter_key', 'OPENROUTER-KEY', '1KEY', '']) {
        expect(
          apiKeyPolicySchema.safeParse({ policyVersion: 1, providerKeys: { openrouter: bad } })
            .success,
        ).toBe(false);
      }
    });

    it('REJECTS providerKeys naming a provider without override support (fail-closed)', () => {
      // cohere has its own private ALS but does NOT honour the CONN-1665
      // override context — a policy naming it would silently use the shared key.
      const result = apiKeyPolicySchema.safeParse({
        policyVersion: 1,
        providerKeys: { cohere: 'COHERE_API_KEY_EMAIL_AGENT' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toContain('cohere');
      }
    });

    it('KEY_OVERRIDE_CAPABLE currently allows exactly openrouter', () => {
      expect(KEY_OVERRIDE_CAPABLE).toEqual(['openrouter']);
    });
  });

  it('rejects non-object payloads', () => {
    for (const bad of [null, 'policy', 42, []]) {
      expect(apiKeyPolicySchema.safeParse(bad).success).toBe(false);
    }
  });
});

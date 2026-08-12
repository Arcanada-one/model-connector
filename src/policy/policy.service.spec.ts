// CONN-1665 — PolicyService unit tests: provider/model gates, catalog-tier
// fail-closed semantics, env-name resolution, per-key policy cache.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PolicyService, InvalidStoredPolicyError } from './policy.service';
import type { ApiKeyPolicy } from './policy.schema';
import { PrismaService } from '../prisma/prisma.service';

const freeOnlyPolicy: ApiKeyPolicy = {
  policyVersion: 1,
  providers: ['openrouter'],
  models: { mode: 'free-only' },
};

function buildService(overrides: { apiKeyRow?: unknown; catalogRow?: unknown } = {}) {
  const prisma = {
    apiKey: {
      findUnique: vi.fn().mockResolvedValue(overrides.apiKeyRow ?? null),
    },
    modelCatalog: {
      findUnique: vi.fn().mockResolvedValue(overrides.catalogRow ?? null),
    },
  };
  return { service: new PolicyService(prisma as unknown as PrismaService), prisma };
}

describe('PolicyService (CONN-1665)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('isProviderAllowed', () => {
    const { service } = buildService();

    it('null/undefined policy → allowed (legacy unrestricted)', () => {
      expect(service.isProviderAllowed(null, 'openrouter')).toBe(true);
      expect(service.isProviderAllowed(undefined, 'groq')).toBe(true);
    });

    it('policy without providers → allowed', () => {
      expect(service.isProviderAllowed({ policyVersion: 1 }, 'groq')).toBe(true);
    });

    it('membership check when providers present', () => {
      expect(service.isProviderAllowed(freeOnlyPolicy, 'openrouter')).toBe(true);
      expect(service.isProviderAllowed(freeOnlyPolicy, 'groq')).toBe(false);
    });
  });

  describe('isModelAllowed', () => {
    const { service } = buildService();

    it('no policy / no models restriction / mode all → allowed', () => {
      expect(service.isModelAllowed(null, 'openrouter', 'm', undefined).allowed).toBe(true);
      expect(service.isModelAllowed({ policyVersion: 1 }, 'openrouter', 'm', 'paid').allowed).toBe(
        true,
      );
      expect(
        service.isModelAllowed(
          { policyVersion: 1, models: { mode: 'all' } },
          'openrouter',
          'm',
          undefined,
        ).allowed,
      ).toBe(true);
    });

    it("mode 'list' → membership check", () => {
      const policy: ApiKeyPolicy = {
        policyVersion: 1,
        models: { mode: 'list', list: ['deepseek-v4-flash'] },
      };
      expect(
        service.isModelAllowed(policy, 'openrouter', 'deepseek-v4-flash', 'paid').allowed,
      ).toBe(true);
      const denied = service.isModelAllowed(policy, 'openrouter', 'gpt-5', 'paid');
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toContain('gpt-5');
    });

    it("mode 'free-only' → catalog tier 'free' allowed, 'paid' denied", () => {
      expect(service.isModelAllowed(freeOnlyPolicy, 'openrouter', 'm1', 'free').allowed).toBe(true);
      const denied = service.isModelAllowed(freeOnlyPolicy, 'openrouter', 'm2', 'paid');
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toContain('paid');
    });

    it("mode 'free-only' + unknown tier → DENY with a distinct not-in-catalog message (fail-closed)", () => {
      const denied = service.isModelAllowed(freeOnlyPolicy, 'openrouter', 'mystery', undefined);
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toContain('not recorded as free-tier in the model catalog');
    });

    it('denial reasons never contain env var names', () => {
      const policy: ApiKeyPolicy = {
        ...freeOnlyPolicy,
        providerKeys: { openrouter: 'OPENROUTER_API_KEY_EMAIL_AGENT' },
      };
      for (const tier of ['paid', undefined] as const) {
        const { reason } = service.isModelAllowed(policy, 'openrouter', 'm', tier);
        expect(reason).not.toContain('OPENROUTER_API_KEY_EMAIL_AGENT');
      }
    });
  });

  describe('getTier (catalog-derived, cached)', () => {
    it("returns 'free'/'paid' from the catalog row", async () => {
      const { service } = buildService({ catalogRow: { tier: 'free', absent: false } });
      await expect(service.getTier('openrouter', 'm')).resolves.toBe('free');
    });

    it("persisted 'unknown' tier or missing row → undefined", async () => {
      const unknown = buildService({ catalogRow: { tier: 'unknown', absent: false } });
      await expect(unknown.service.getTier('openrouter', 'm')).resolves.toBeUndefined();
      const missing = buildService();
      await expect(missing.service.getTier('openrouter', 'm')).resolves.toBeUndefined();
    });

    it('absent (removed-from-provider) rows do not count', async () => {
      const { service } = buildService({ catalogRow: { tier: 'free', absent: true } });
      await expect(service.getTier('openrouter', 'm')).resolves.toBeUndefined();
    });

    it('caches per (provider, model)', async () => {
      const { service, prisma } = buildService({ catalogRow: { tier: 'paid', absent: false } });
      await service.getTier('openrouter', 'm');
      await service.getTier('openrouter', 'm');
      expect(prisma.modelCatalog.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPolicyForKey (cached, fail-closed on malformed)', () => {
    it('null column → null policy, cached', async () => {
      const { service, prisma } = buildService({ apiKeyRow: { policy: null } });
      await expect(service.getPolicyForKey('k1')).resolves.toBeNull();
      await service.getPolicyForKey('k1');
      expect(prisma.apiKey.findUnique).toHaveBeenCalledTimes(1);
    });

    it('valid stored policy → parsed policy', async () => {
      const { service } = buildService({ apiKeyRow: { policy: freeOnlyPolicy } });
      await expect(service.getPolicyForKey('k1')).resolves.toEqual(freeOnlyPolicy);
    });

    it('malformed stored policy → InvalidStoredPolicyError (never unrestricted fallback)', async () => {
      const { service } = buildService({ apiKeyRow: { policy: { policyVersion: 99 } } });
      await expect(service.getPolicyForKey('k1')).rejects.toBeInstanceOf(InvalidStoredPolicyError);
    });

    it('invalidateKey drops the cache entry', async () => {
      const { service, prisma } = buildService({ apiKeyRow: { policy: null } });
      await service.getPolicyForKey('k1');
      service.invalidateKey('k1');
      await service.getPolicyForKey('k1');
      expect(prisma.apiKey.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('resolveProviderKeyEnv', () => {
    const { service } = buildService();
    const policy: ApiKeyPolicy = {
      policyVersion: 1,
      providerKeys: { openrouter: 'OPENROUTER_API_KEY_EMAIL_AGENT' },
    };

    it('returns the env var NAME for a named provider', () => {
      expect(service.resolveProviderKeyEnv(policy, 'openrouter')).toBe(
        'OPENROUTER_API_KEY_EMAIL_AGENT',
      );
    });

    it('returns null for unnamed providers and null policy', () => {
      expect(service.resolveProviderKeyEnv(policy, 'groq')).toBeNull();
      expect(service.resolveProviderKeyEnv(null, 'openrouter')).toBeNull();
    });
  });
});

// reuse: policy reference metadata and existing protected environment injection.
import { z } from 'zod';
import type { ApiKeyPolicy } from './policy.schema';
import type { ProviderKeyOverride } from './provider-key.context';

const registrySchema = z.record(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  z
    .object({
      provider: z.enum(['openrouter', 'typesafe-jev', 'deepseek']),
      profileId: z.string().min(1).max(64),
      clientKeyIds: z.array(z.string().min(1).max(100)).min(1),
      versions: z.record(z.string().min(1).max(64), z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
    })
    .strict(),
);

const prefixes: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY_',
  'typesafe-jev': 'TYPESAFE_API_KEY_',
  deepseek: 'DEEPSEEK_API_KEY_',
};

/** Metadata only: secret values must be injected separately by protected custody. */
export function validateCredentialRegistry(raw: string) {
  return registrySchema.parse(JSON.parse(raw));
}

/** First binding is explicitly pinned. Never advance on failure or read client aliases. */
export function resolveRegisteredCredential(
  policy: ApiKeyPolicy,
  provider: string,
  clientKeyId: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderKeyOverride {
  try {
    const profile = policy.profile;
    const bindings = policy.providerKeys?.[provider];
    if (policy.policyVersion !== 2 || !profile || !Array.isArray(bindings) || !bindings.length) {
      throw new Error();
    }
    const registry = validateCredentialRegistry(env.PROVIDER_CREDENTIAL_REGISTRY ?? '{}');
    const selected = bindings[0];
    if (!Object.hasOwn(registry, selected.credentialRef)) throw new Error();
    const registered = registry[selected.credentialRef];
    if (
      registered.provider !== provider ||
      registered.profileId !== profile.id ||
      !registered.clientKeyIds.includes(clientKeyId) ||
      !Object.hasOwn(registered.versions, selected.version)
    )
      throw new Error();
    const name = registered.versions[selected.version];
    if (!name.startsWith(prefixes[provider] ?? '\0') || !env[name]?.trim()) throw new Error();
    return {
      provider,
      apiKey: env[name]!,
      credentialRef: selected.credentialRef,
      credentialVersion: selected.version,
      profileId: profile.id,
      profileRevision: profile.revision,
      accountingBucket: profile.accountingBucket,
    };
  } catch {
    // Do not leak Zod inputs, env names, references or JSON parse fragments.
    throw new Error('Dedicated provider credential is unavailable or unauthorized');
  }
}

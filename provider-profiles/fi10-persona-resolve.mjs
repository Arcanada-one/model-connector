/**
 * FI10-T3.8 — fail-closed FI10 critic persona → dedicated provider profile resolver.
 *
 * Pattern: DEC-AUP-0143 dedicated provider profiles (profileId + accountingBucket).
 * Synthetic / source-only: does not contact providers, does not read secrets.
 * runtime_authorized=false; knowledge_admitted=false; effect_authorized=false.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(HERE, 'fi10-persona-catalog.json');

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class Fi10PersonaResolveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Fi10PersonaResolveError';
    this.code = code;
  }
}

function loadCatalog(catalogPath = CATALOG_PATH) {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (catalog.schema !== 'ModelConnectorFi10CriticPersonaCatalog/v1') {
    throw new Fi10PersonaResolveError('CATALOG_SCHEMA', 'Unexpected FI10 persona catalog schema');
  }
  return catalog;
}

function normalizeTag(tag) {
  if (typeof tag !== 'string') return '';
  return tag.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isForbiddenItPersona(tag, catalog) {
  const n = normalizeTag(tag);
  if (!n) return true;
  const prefixes = catalog.it_profiles?.forbidden_persona_prefixes ?? ['it', 'it-', 'it.', 'it/'];
  return prefixes.some((p) => n === p.replace(/[-./]$/, '') || n.startsWith(p));
}

function indexPersonas(catalog) {
  const byTag = new Map();
  for (const row of catalog.personas ?? []) {
    const keys = [row.persona, row.label, ...(row.aliases ?? [])];
    for (const key of keys) {
      const n = normalizeTag(key);
      if (!n) continue;
      if (byTag.has(n) && byTag.get(n).persona !== row.persona) {
        throw new Fi10PersonaResolveError('CATALOG_ALIAS_COLLISION', `Alias collision for ${n}`);
      }
      byTag.set(n, row);
    }
  }
  return byTag;
}

function assertFi10Accounting(bucket, catalog) {
  if (typeof bucket !== 'string' || !PROFILE_ID_RE.test(bucket)) {
    throw new Fi10PersonaResolveError('ACCOUNTING_SHAPE', 'accountingBucket shape invalid');
  }
  if (!bucket.startsWith('fi10-')) {
    throw new Fi10PersonaResolveError('ACCOUNTING_NOT_FI10', 'accountingBucket must be fi10-*');
  }
  const forbidden = catalog.it_profiles?.forbidden_accounting_prefixes ?? ['it', 'it-', 'it.'];
  if (forbidden.some((p) => bucket === p.replace(/[-.]$/, '') || bucket.startsWith(p))) {
    throw new Fi10PersonaResolveError('ACCOUNTING_IT_LEAK', 'IT accounting bucket refused');
  }
}

/**
 * Resolve a request persona tag to its dedicated FI10 provider profile binding.
 * Unknown / IT / empty tags fail closed and never fall back to an IT profile.
 */
export function resolveFi10Persona(personaTag, options = {}) {
  const catalog = options.catalog ?? loadCatalog(options.catalogPath);
  const tag = normalizeTag(personaTag);

  if (!tag) {
    throw new Fi10PersonaResolveError('PERSONA_REQUIRED', 'persona tag required');
  }
  if (isForbiddenItPersona(tag, catalog)) {
    throw new Fi10PersonaResolveError(
      'PERSONA_IT_FORBIDDEN',
      `IT or reserved persona refused: ${tag}`,
    );
  }

  const byTag = options._index ?? indexPersonas(catalog);
  const row = byTag.get(tag);
  if (!row) {
    throw new Fi10PersonaResolveError('PERSONA_UNKNOWN', `Unknown FI10 persona refused: ${tag}`);
  }

  assertFi10Accounting(row.accountingBucket, catalog);
  if (row.profileId !== row.accountingBucket || !row.profileId.startsWith('fi10-')) {
    throw new Fi10PersonaResolveError('PROFILE_NOT_FI10', 'profileId must be fi10-* and match bucket');
  }
  if (!PROFILE_ID_RE.test(row.profileId)) {
    throw new Fi10PersonaResolveError('PROFILE_SHAPE', 'profileId shape invalid');
  }

  const policyPath = join(HERE, row.policyFile);
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  if (policy.policyVersion !== 2 || policy.profile?.id !== row.profileId) {
    throw new Fi10PersonaResolveError('POLICY_MISMATCH', `policy file mismatch for ${row.persona}`);
  }
  if (policy.profile?.accountingBucket !== row.accountingBucket) {
    throw new Fi10PersonaResolveError(
      'POLICY_ACCOUNTING_MISMATCH',
      `policy accountingBucket mismatch for ${row.persona}`,
    );
  }

  return {
    persona: row.persona,
    label: row.label,
    profileId: row.profileId,
    profileRevision: policy.profile.revision,
    accountingBucket: row.accountingBucket,
    policyFile: row.policyFile,
    credentialRefs: { ...row.credentialRefs },
    policy,
  };
}

export function listFi10Personas(options = {}) {
  const catalog = options.catalog ?? loadCatalog(options.catalogPath);
  return (catalog.personas ?? []).map((p) => ({
    persona: p.persona,
    label: p.label,
    profileId: p.profileId,
    accountingBucket: p.accountingBucket,
  }));
}

export { loadCatalog, CATALOG_PATH, HERE as PROVIDER_PROFILES_DIR };

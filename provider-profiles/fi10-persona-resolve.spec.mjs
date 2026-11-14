/**
 * FI10-T3.8 synthetic controls for persona → FI10 profile routing / accounting.
 * Labelled synthetic. No network. No secrets.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Fi10PersonaResolveError,
  PROVIDER_PROFILES_DIR,
  listFi10Personas,
  loadCatalog,
  resolveFi10Persona,
} from './fi10-persona-resolve.mjs';

const EXPECTED = [
  'fi10-humanitarian-field',
  'fi10-engineering-physical',
  'fi10-supply-finance',
  'fi10-statistics-indicators',
  'fi10-legal-external-bodies',
];

describe('FI10 critic persona provider profiles (synthetic)', () => {
  it('catalog exposes exactly five fi10-* personas with distinct accounting buckets', () => {
    const catalog = loadCatalog();
    const personas = listFi10Personas({ catalog });
    assert.equal(personas.length, 5);
    assert.deepEqual(
      personas.map((p) => p.persona).sort(),
      [...EXPECTED].sort(),
    );
    const buckets = new Set(personas.map((p) => p.accountingBucket));
    assert.equal(buckets.size, 5);
    for (const b of buckets) {
      assert.match(b, /^fi10-/);
      assert.equal(b.startsWith('it'), false);
    }
  });

  it('positive: each FI10 persona tag routes and accounts to its own fi10 key', () => {
    const catalog = loadCatalog();
    for (const row of catalog.personas) {
      for (const tag of [row.persona, row.label, ...(row.aliases ?? [])]) {
        const resolved = resolveFi10Persona(tag, { catalog });
        assert.equal(resolved.persona, row.persona);
        assert.equal(resolved.profileId, row.profileId);
        assert.equal(resolved.accountingBucket, row.accountingBucket);
        assert.equal(resolved.accountingBucket.startsWith('fi10-'), true);
        assert.equal(resolved.policy.profile.accountingBucket, row.accountingBucket);
        assert.notEqual(resolved.accountingBucket.startsWith('it'), true);
      }
    }
  });

  it('negative: unknown persona fails closed and does not return an IT profile', () => {
    const unknowns = [
      'fi10-unknown-persona',
      'unknown',
      'humanitarian',
      '',
      '   ',
      null,
      undefined,
    ];
    for (const tag of unknowns) {
      assert.throws(
        () => resolveFi10Persona(tag),
        (err) =>
          err instanceof Fi10PersonaResolveError &&
          ['PERSONA_UNKNOWN', 'PERSONA_REQUIRED'].includes(err.code),
      );
    }
  });

  it('negative: IT persona tags fail closed (never routed to IT or FI10)', () => {
    const itTags = ['it', 'it-critic', 'it/field', 'IT', 'it.generation'];
    for (const tag of itTags) {
      assert.throws(
        () => resolveFi10Persona(tag),
        (err) => err instanceof Fi10PersonaResolveError && err.code === 'PERSONA_IT_FORBIDDEN',
      );
    }
  });

  it('policy files are DEC-AUP-0143 v2 shape and accounting-separated from each other', () => {
    const catalog = loadCatalog();
    const seenBuckets = new Set();
    for (const row of catalog.personas) {
      const policy = JSON.parse(readFileSync(join(PROVIDER_PROFILES_DIR, row.policyFile), 'utf8'));
      assert.equal(policy.policyVersion, 2);
      assert.equal(policy.profile.id, row.profileId);
      assert.equal(policy.profile.accountingBucket, row.accountingBucket);
      assert.ok(Array.isArray(policy.providers));
      assert.ok(policy.providerKeys.deepseek);
      assert.ok(policy.providerKeys['typesafe-jev']);
      assert.equal(seenBuckets.has(row.accountingBucket), false);
      seenBuckets.add(row.accountingBucket);
    }
  });

  it('credential registry fragment carries env NAMES only (no secret-looking values)', () => {
    const frag = JSON.parse(
      readFileSync(join(PROVIDER_PROFILES_DIR, 'fi10-credential-registry.fragment.json'), 'utf8'),
    );
    assert.equal(frag.schema, 'ModelConnectorFi10CredentialRegistryFragment/v1');
    for (const [ref, entry] of Object.entries(frag.registry)) {
      assert.match(ref, /^fi10[a-z0-9]+-(deepseek|jev)$/);
      assert.equal(entry.profileId.startsWith('fi10-'), true);
      for (const envName of Object.values(entry.versions)) {
        assert.match(envName, /^[A-Z][A-Z0-9_]*$/);
        assert.equal(envName.includes('sk-'), false);
        assert.equal(envName.length < 80, true);
      }
    }
  });
});
